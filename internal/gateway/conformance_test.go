package gateway

// Streamable HTTP conformance of /mcp for callers that are not the Go SDK (cloud MCP clients, curl-style scripts):
// raw JSON-RPC over HTTP, the SDK client, and both of them through a reverse proxy. docs/PUBLIC-ENDPOINT.md
// records what these tests show.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type reply struct {
	Status int
	Header http.Header
	Body   string
}

// rpc sends one raw POST to /mcp. headers override the defaults (an empty value removes the header).
func rpc(t *testing.T, endpoint, tok, body string, headers map[string]string) reply {
	t.Helper()
	return send(t, "POST", endpoint, tok, []byte(body), headers)
}

func send(t *testing.T, method, endpoint, tok string, body []byte, headers map[string]string) reply {
	t.Helper()
	req, _ := http.NewRequest(method, endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	for k, v := range headers {
		if k == "Host" {
			req.Host = v
		} else if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	// A hang is a failure: no request in this file may wait longer than this.
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, endpoint, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return reply{resp.StatusCode, resp.Header, string(b)}
}

func mustURL(t *testing.T, s string) *url.URL {
	t.Helper()
	u, err := url.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func jsonBody(t *testing.T, r reply) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(r.Body), &m); err != nil {
		t.Fatalf("not a JSON object (status %d, %q): %v", r.Status, r.Body, err)
	}
	return m
}

const initReq = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"0"}}}`

func TestRawLifecycleInitializeListCallPingAndErrors(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "raw", "*")
	url := e.gw.URL + "/mcp"

	r := rpc(t, url, tok, initReq, nil)
	if r.Status != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("initialize: %d %s %q", r.Status, r.Header.Get("Content-Type"), r.Body)
	}
	init := jsonBody(t, r)
	res := init["result"].(map[string]any)
	if res["serverInfo"].(map[string]any)["name"] != "cammut" || res["protocolVersion"] == "" {
		t.Fatalf("initialize result: %v", res)
	}
	if _, ok := res["capabilities"].(map[string]any)["tools"]; !ok {
		t.Fatalf("tools capability missing: %v", res)
	}
	if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
		t.Fatalf("a stateless server must not hand out a session id, got %q", sid)
	}

	// notifications carry no id and get 202 with no body
	r = rpc(t, url, tok, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil)
	if r.Status != 202 || strings.TrimSpace(r.Body) != "" {
		t.Fatalf("notifications/initialized: %d %q", r.Status, r.Body)
	}

	// each request stands alone: tools/list works without a prior initialize on the same "connection"
	r = rpc(t, url, tok, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, nil)
	tools := jsonBody(t, r)["result"].(map[string]any)["tools"].([]any)
	if r.Status != 200 || len(tools) != 4 {
		t.Fatalf("tools/list: %d %q", r.Status, r.Body)
	}

	r = rpc(t, url, tok, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cammut_call","arguments":{"tool":"alpha/echo","arguments":{"msg":"raw hello"}}}}`, nil)
	out := jsonBody(t, r)["result"].(map[string]any)
	if r.Status != 200 || out["content"].([]any)[0].(map[string]any)["text"] != "raw hello" {
		t.Fatalf("tools/call: %d %q", r.Status, r.Body)
	}

	r = rpc(t, url, tok, `{"jsonrpc":"2.0","id":4,"method":"ping"}`, nil)
	if got := jsonBody(t, r); r.Status != 200 || got["error"] != nil || got["id"] != float64(4) {
		t.Fatalf("ping: %d %q", r.Status, r.Body)
	}

	// standard probes a client may send even though Cammut offers no prompts or resources: empty lists, not errors
	for _, m := range []string{"prompts/list", "resources/list", "resources/templates/list"} {
		r = rpc(t, url, tok, `{"jsonrpc":"2.0","id":5,"method":"`+m+`"}`, nil)
		if got := jsonBody(t, r); r.Status != 200 || got["error"] != nil || got["id"] != float64(5) {
			t.Fatalf("%s: %d %q", m, r.Status, r.Body)
		}
	}
	// A method the SDK does not know at all (with or without an id) is a clean, immediate 400 with a plain-text reason,
	// not a JSON-RPC error object. Recorded in docs/PUBLIC-ENDPOINT.md; no real client sends such a method.
	for _, body := range []string{`{"jsonrpc":"2.0","id":5,"method":"no/such/method"}`, `{"jsonrpc":"2.0","method":"no/such/method"}`} {
		if r = rpc(t, url, tok, body, nil); r.Status != 400 || !strings.Contains(r.Body, "no/such/method") {
			t.Fatalf("unknown method: %d %q", r.Status, r.Body)
		}
	}
	// a method that exists but is refused is a proper JSON-RPC error with the request id
	r = rpc(t, url, tok, `{"jsonrpc":"2.0","id":5,"method":"resources/subscribe","params":{"uri":"x"}}`, nil)
	if e5 := jsonBody(t, r); e5["error"].(map[string]any)["code"] != float64(-32601) || e5["id"] != float64(5) {
		t.Fatalf("resources/subscribe: %d %q", r.Status, r.Body)
	}

	// an unknown tool name is a JSON-RPC error too; malformed JSON is a clean 4xx
	r = rpc(t, url, tok, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nope"}}`, nil)
	if jsonBody(t, r)["error"] == nil {
		t.Fatalf("unknown tool: %d %q", r.Status, r.Body)
	}
	if r = rpc(t, url, tok, `{"jsonrpc":`, nil); r.Status < 400 || r.Status >= 500 {
		t.Fatalf("truncated JSON: %d %q", r.Status, r.Body)
	}
	// the server is still fine afterwards
	if r = rpc(t, url, tok, listReq, nil); r.Status != 200 {
		t.Fatalf("after errors: %d", r.Status)
	}
}

func TestAcceptVariants(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "acc", "*")
	for _, accept := range []string{
		"application/json, text/event-stream",
		"text/event-stream, application/json",
		"application/json,text/event-stream;q=0.5",
		"*/*",
		"application/json",
		"text/event-stream",
		"application/*",
		"",
	} {
		r := rpc(t, e.gw.URL+"/mcp", tok, listReq, map[string]string{"Accept": accept})
		if r.Status != 200 {
			t.Errorf("Accept %q: %d %s", accept, r.Status, r.Body)
			continue
		}
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("Accept %q: the reply must be plain JSON, got %q", accept, ct)
		}
	}
	// the content type is not negotiable
	if r := rpc(t, e.gw.URL+"/mcp", tok, listReq, map[string]string{"Content-Type": "text/plain"}); r.Status != 415 {
		t.Errorf("text/plain body: %d", r.Status)
	}
	if r := rpc(t, e.gw.URL+"/mcp", tok, listReq, map[string]string{"Content-Type": "application/json; charset=utf-8"}); r.Status != 200 {
		t.Errorf("a charset parameter must be accepted: %d", r.Status)
	}
}

func TestProtocolVersionHeader(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "ver", "*")
	for _, v := range []string{"", "2025-06-18", "2025-03-26", "2024-11-05"} {
		if r := rpc(t, e.gw.URL+"/mcp", tok, listReq, map[string]string{"MCP-Protocol-Version": v}); r.Status != 200 {
			t.Errorf("MCP-Protocol-Version %q: %d %s", v, r.Status, r.Body)
		}
	}
	for _, v := range []string{"1999-01-01", "bogus"} {
		if r := rpc(t, e.gw.URL+"/mcp", tok, listReq, map[string]string{"MCP-Protocol-Version": v}); r.Status != 400 {
			t.Errorf("MCP-Protocol-Version %q must be a 400, got %d", v, r.Status)
		}
	}
}

func TestGetAndDeleteAreCleanly405InStatelessMode(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "gd", "*")
	url := e.gw.URL + "/mcp"
	for _, method := range []string{"GET", "DELETE", "PUT", "PATCH"} {
		// 10 s client timeout in send: a hanging SSE stream would fail here
		r := send(t, method, url, tok, nil, map[string]string{"Accept": "text/event-stream", "Mcp-Session-Id": "x"})
		if r.Status != 405 || !strings.Contains(r.Header.Get("Allow"), "POST") {
			t.Errorf("%s with a token: %d Allow=%q", method, r.Status, r.Header.Get("Allow"))
		}
		// without a token the answer is the same 401 as for POST: nothing is learned about the method table
		if r = send(t, method, url, "", nil, nil); r.Status != 401 {
			t.Errorf("%s without a token: %d", method, r.Status)
		}
	}
}

func TestConcurrentCallsDoNotCrossTalk(t *testing.T) {
	e := newEnv(t, 10000)
	tok := e.token(t, "conc", "*")
	const n = 40
	var wg sync.WaitGroup
	errs := make(chan string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			msg := fmt.Sprintf("m-%d", i)
			body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"cammut_call","arguments":{"tool":"alpha/echo","arguments":{"msg":%q}}}}`, i+100, msg)
			req, _ := http.NewRequest("POST", e.gw.URL+"/mcp", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("Authorization", "Bearer "+tok)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				errs <- err.Error()
				return
			}
			defer resp.Body.Close()
			b, _ := io.ReadAll(resp.Body)
			var m struct {
				ID     float64 `json:"id"`
				Result struct {
					Content []struct{ Text string } `json:"content"`
				} `json:"result"`
			}
			if json.Unmarshal(b, &m) != nil || m.ID != float64(i+100) || len(m.Result.Content) != 1 || m.Result.Content[0].Text != msg {
				errs <- fmt.Sprintf("call %d: %d %s", i, resp.StatusCode, b)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for msg := range errs {
		t.Error(msg)
	}
}

func TestLargeResultsAndTheResultCap(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "big", "*"))
	// just under the 1 MiB cap on the marshalled result: delivered whole
	under := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/big", "arguments": map[string]any{"n": maxResult - 1024}})
	if under.IsError || len(textOf(t, under)) != maxResult-1024 {
		t.Fatalf("a result just under the cap must arrive intact: error=%v len=%d", under.IsError, len(textOf(t, under)))
	}
	// 1 MiB of text is over the cap once wrapped: a tool error, not a truncated body, and the session keeps working
	over := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/big", "arguments": map[string]any{"n": maxResult}})
	if !over.IsError || !strings.Contains(textOf(t, over), "result too large") {
		t.Fatalf("1 MiB result: error=%v %.80s", over.IsError, textOf(t, over))
	}
	if r := call(t, cs, "cammut_call", map[string]any{"tool": "beta/ping"}); r.IsError || textOf(t, r) != "pong" {
		t.Fatal("unusable after an oversized result")
	}
}

func TestSlowToolAnswersAndDoesNotBlockOthers(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "slow", "*")
	slowDone := make(chan reply, 1)
	start := time.Now()
	go func() {
		slowDone <- rpc(t, e.gw.URL+"/mcp", tok, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cammut_call","arguments":{"tool":"alpha/slow","arguments":{"ms":1500}}}}`, nil)
	}()
	time.Sleep(100 * time.Millisecond)
	fast := time.Now()
	if r := rpc(t, e.gw.URL+"/mcp", tok, listReq, nil); r.Status != 200 || time.Since(fast) > 1000*time.Millisecond {
		t.Fatalf("a fast call behind a slow one: %d in %v", r.Status, time.Since(fast))
	}
	r := <-slowDone
	out := jsonBody(t, r)["result"].(map[string]any)
	if r.Status != 200 || out["content"].([]any)[0].(map[string]any)["text"] != "slept" || time.Since(start) < 1500*time.Millisecond {
		t.Fatalf("slow tool: %d %q after %v", r.Status, r.Body, time.Since(start))
	}
}

// proxied puts an httputil.ReverseProxy in front of the gateway, the way Cloudflare Tunnel or Caddy sit in front of
// it: the proxy appends the address it saw to X-Forwarded-For and adds X-Forwarded-Proto/Host.
func proxied(t *testing.T, e *env, seenClient string) *httptest.Server {
	t.Helper()
	target := e.gw.URL
	rp := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			u := mustURL(t, target)
			r.SetURL(u)
			r.Out.Host = r.In.Host
			prior := r.In.Header.Get("X-Forwarded-For")
			if prior != "" {
				prior += ", "
			}
			r.Out.Header.Set("X-Forwarded-For", prior+seenClient)
			r.Out.Header.Set("X-Forwarded-Proto", "https")
			r.Out.Header.Set("X-Forwarded-Host", "cammut.example")
		},
		FlushInterval: -1,
	}
	px := httptest.NewServer(rp)
	t.Cleanup(px.Close)
	return px
}

func TestThroughAReverseProxy(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "px", "*")
	px := proxied(t, e, "198.51.100.9")

	// the SDK client, with a forged X-Forwarded-For and X-Cammut-Client-IP of its own
	c := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil)
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: px.URL + "/mcp", DisableStandaloneSSE: true, MaxRetries: -1,
		HTTPClient: &http.Client{Transport: forwarded{tok: tok, xff: "6.6.6.6", spoof: "7.7.7.7"}},
	}, nil)
	if err != nil {
		t.Fatalf("connect through the proxy: %v", err)
	}
	defer cs.Close()
	if r := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/echo", "arguments": map[string]any{"msg": "via proxy"}}); r.IsError || textOf(t, r) != "via proxy" {
		t.Fatalf("call through the proxy: %v %s", r.IsError, textOf(t, r))
	}
	rows, _ := e.st.RecentAudit(1)
	if len(rows) != 1 || rows[0].IP != "198.51.100.9" {
		t.Fatalf("the audited address is the one the proxy appended, never a client-sent one: %+v", rows)
	}

	// raw HTTP through the proxy: every shape from the lifecycle test
	for _, body := range []string{initReq, listReq, `{"jsonrpc":"2.0","id":9,"method":"ping"}`} {
		if r := rpc(t, px.URL+"/mcp", tok, body, nil); r.Status != 200 {
			t.Fatalf("%s through the proxy: %d %q", body, r.Status, r.Body)
		}
	}
	if r := rpc(t, px.URL+"/mcp", tok, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil); r.Status != 202 {
		t.Fatalf("notification through the proxy: %d", r.Status)
	}
	if r := send(t, "GET", px.URL+"/mcp", tok, nil, map[string]string{"Accept": "text/event-stream"}); r.Status != 405 {
		t.Fatalf("GET through the proxy: %d", r.Status)
	}
	// the public Host the proxy forwards is not rejected (DNS-rebinding guard is off, the bearer token is the gate)
	if r := rpc(t, px.URL+"/mcp", tok, listReq, map[string]string{"Host": "cammut.example"}); r.Status != 200 {
		t.Fatalf("public Host: %d", r.Status)
	}
}
