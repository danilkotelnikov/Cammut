package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/ratelimit"
	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
	"cammut/internal/upstream"
)

type env struct {
	st   *store.Store
	mgr  *upstream.Manager
	gw   *httptest.Server
	urls map[string]string
}

func newEnv(t *testing.T, burst int) *env { return newEnvRate(t, 1000, burst) }

func newEnvRate(t *testing.T, rate float64, burst int) *env {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	alpha := fakemcp.New(t, "",
		fakemcp.Tool{Name: "echo", Description: "Echo a message back", Run: func(a map[string]any) string { return fmt.Sprint(a["msg"]) }},
		fakemcp.Tool{Name: "secret_tool", Description: "Admin only operation", Run: func(map[string]any) string { return "classified" }},
		fakemcp.Tool{Name: "slow", Description: "Sleeps ms milliseconds", Run: func(a map[string]any) string {
			ms, _ := a["ms"].(float64)
			time.Sleep(time.Duration(ms) * time.Millisecond)
			return "slept"
		}},
		fakemcp.Tool{Name: "big", Description: "Returns n bytes", Run: func(a map[string]any) string {
			n, _ := a["n"].(float64)
			return strings.Repeat("x", int(n))
		}})
	beta := fakemcp.New(t, "", fakemcp.Tool{Name: "ping", Description: "Reply pong", Run: func(map[string]any) string { return "pong" }})
	mgr := upstream.NewManager(func(string) string { return "" })
	mgr.Set([]store.Upstream{
		{Name: "alpha", URL: alpha.URL, Enabled: true},
		{Name: "beta", URL: beta.URL, Enabled: true},
	})
	gw := httptest.NewServer(Handler(Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(rate, burst)}))
	t.Cleanup(gw.Close)
	return &env{st, mgr, gw, map[string]string{"alpha": alpha.URL, "beta": beta.URL}}
}

func (e *env) token(t *testing.T, label string, scopes ...string) string {
	t.Helper()
	plain, _, err := e.st.CreateToken(label, scopes)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}

type bearer struct{ tok string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.tok)
	return http.DefaultTransport.RoundTrip(r)
}

func (e *env) client(t *testing.T, tok string) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: e.gw.URL + "/mcp", HTTPClient: &http.Client{Transport: bearer{tok}}, DisableStandaloneSSE: true, MaxRetries: -1,
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error %v", name, err)
	}
	return res
}

func textOf(t *testing.T, r *mcp.CallToolResult) string {
	t.Helper()
	if len(r.Content) == 0 {
		t.Fatal("no content")
	}
	return r.Content[0].(*mcp.TextContent).Text
}

func rawPost(t *testing.T, url, tok string, body []byte) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

const listReq = `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`

func TestAuthRequired(t *testing.T) {
	e := newEnv(t, 1000)
	if r := rawPost(t, e.gw.URL+"/mcp", "", []byte(listReq)); r.StatusCode != 401 {
		t.Fatalf("no token: %d", r.StatusCode)
	}
	if r := rawPost(t, e.gw.URL+"/mcp", "cmt_nope", []byte(listReq)); r.StatusCode != 401 {
		t.Fatalf("bad token: %d", r.StatusCode)
	}
	tok := e.token(t, "a", "*")
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte(listReq)); r.StatusCode != 200 {
		t.Fatalf("good token: %d", r.StatusCode)
	}
	if ok, _ := e.st.RevokeToken("a"); !ok {
		t.Fatal("revoke failed")
	}
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte(listReq)); r.StatusCode != 401 {
		t.Fatalf("revoked token must stop at once: %d", r.StatusCode)
	}
}

func TestExposesExactlyFourLazyTools(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "a", "*"))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
	}
	if strings.Join(names, ",") != "cammut_call,cammut_describe,cammut_search,cammut_servers" {
		// the SDK may return tools in any order; compare as a set
		set := map[string]bool{}
		for _, n := range names {
			set[n] = true
		}
		for _, want := range []string{"cammut_servers", "cammut_search", "cammut_describe", "cammut_call"} {
			if !set[want] {
				t.Fatalf("missing %s in %v", want, names)
			}
		}
		if len(names) != 4 {
			t.Fatalf("want exactly 4 tools, got %v", names)
		}
	}
}

func TestScopedTokenSeesOnlyItsTools(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "scoped", "alpha/echo"))

	servers := textOf(t, call(t, cs, "cammut_servers", nil))
	if !strings.Contains(servers, `"alpha"`) || strings.Contains(servers, `"beta"`) {
		t.Fatalf("servers: %s", servers)
	}
	found := textOf(t, call(t, cs, "cammut_search", map[string]any{"query": "echo ping secret"}))
	if !strings.Contains(found, "alpha/echo") || strings.Contains(found, "secret_tool") || strings.Contains(found, "beta/ping") {
		t.Fatalf("search leaked: %s", found)
	}
	if r := call(t, cs, "cammut_describe", map[string]any{"tool": "alpha/secret_tool"}); !r.IsError {
		t.Fatalf("describe of a denied tool must be an error result: %s", textOf(t, r))
	}
	ok := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/echo", "arguments": map[string]any{"msg": "hi"}})
	if ok.IsError || textOf(t, ok) != "hi" {
		t.Fatalf("allowed call failed: %v %s", ok.IsError, textOf(t, ok))
	}
	denied := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/secret_tool"})
	if !denied.IsError || strings.Contains(textOf(t, denied), "classified") {
		t.Fatalf("denied call must not run: %s", textOf(t, denied))
	}
	rows, _ := e.st.QueryAudit(store.AuditFilter{Upstream: "alpha"})
	if len(rows) != 2 {
		t.Fatalf("want 2 audit rows for alpha (one ok, one denied), got %+v", rows)
	}
	if all, _ := e.st.RecentAudit(20); len(all) != 5 {
		t.Fatalf("one row per tools/call, the gateway's own tools included: %+v", all)
	}
}

func TestDescribeReturnsSchema(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "a", "*"))
	out := textOf(t, call(t, cs, "cammut_describe", map[string]any{"tool": "beta/ping"}))
	var d struct {
		Tool        string          `json:"tool"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	}
	if err := json.Unmarshal([]byte(out), &d); err != nil || d.Tool != "beta/ping" || d.Description != "Reply pong" || !strings.Contains(string(d.InputSchema), "object") {
		t.Fatalf("out=%s err=%v", out, err)
	}
}

func TestEmptyScopesDenyEverything(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "none"))
	if s := textOf(t, call(t, cs, "cammut_servers", nil)); strings.TrimSpace(s) != "[]" {
		t.Fatalf("servers: %s", s)
	}
	if s := textOf(t, call(t, cs, "cammut_search", map[string]any{"query": ""})); strings.TrimSpace(s) != "[]" {
		t.Fatalf("search: %s", s)
	}
	if r := call(t, cs, "cammut_call", map[string]any{"tool": "beta/ping"}); !r.IsError {
		t.Fatal("call must be denied")
	}
}

func TestBadKeysAreToolErrorsNotCrashes(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "a", "*"))
	for _, key := range []string{"", "noslash", "/x", "alpha/", "ghost/echo", "alpha/ghost", "a/b/c"} {
		r := call(t, cs, "cammut_call", map[string]any{"tool": key})
		if !r.IsError {
			t.Fatalf("key %q must be an error result, got %s", key, textOf(t, r))
		}
	}
	// the server still works afterwards
	if r := call(t, cs, "cammut_call", map[string]any{"tool": "beta/ping"}); r.IsError || textOf(t, r) != "pong" {
		t.Fatal("server unusable after bad keys")
	}
}

func TestMalformedArguments(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "a", "*")
	cs := e.client(t, tok)
	// arguments must be an object
	if r := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/echo", "arguments": "not an object"}); !r.IsError {
		t.Fatal("non-object arguments must be rejected")
	}
	// a string where limit should be an integer
	if r := call(t, cs, "cammut_search", map[string]any{"query": "x", "limit": "ten"}); !r.IsError {
		t.Fatal("bad limit must be an error result")
	}
	// body over 1 MiB is refused and the server keeps serving
	big := bytes.Repeat([]byte("a"), 2<<20)
	if r := rawPost(t, e.gw.URL+"/mcp", tok, big); r.StatusCode == 200 {
		t.Fatal("oversized body must not succeed")
	}
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte(listReq)); r.StatusCode != 200 {
		t.Fatalf("server must keep serving, got %d", r.StatusCode)
	}
}

func TestDownUpstreamIsContained(t *testing.T) {
	e := newEnv(t, 1000)
	dead := fakemcp.New(t, "", fakemcp.Tool{Name: "x", Description: "never reachable"})
	deadURL := dead.URL
	dead.Close()
	e.mgr.Set([]store.Upstream{
		{Name: "alpha", URL: e.mgrURL(t, "alpha"), Enabled: true},
		{Name: "dead", URL: deadURL, Enabled: true},
	})
	cs := e.client(t, e.token(t, "a", "*"))
	start := time.Now()
	servers := textOf(t, call(t, cs, "cammut_servers", nil))
	if !strings.Contains(servers, `"dead"`) || !strings.Contains(servers, "unreachable") || !strings.Contains(servers, `"alpha"`) {
		t.Fatalf("servers: %s", servers)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("a dead upstream stalled the gateway for %v", time.Since(start))
	}
	r := call(t, cs, "cammut_call", map[string]any{"tool": "dead/x"})
	if !r.IsError {
		t.Fatal("call to a dead upstream must be an error result")
	}
	rows, _ := e.st.RecentAudit(5)
	if len(rows) == 0 || rows[0].OK || rows[0].Upstream != "dead" {
		t.Fatalf("expected a failed audit row for dead/x, got %+v", rows)
	}
	if ok := call(t, cs, "cammut_call", map[string]any{"tool": "alpha/echo", "arguments": map[string]any{"msg": "still"}}); ok.IsError {
		t.Fatal("healthy upstream must keep working")
	}
}

// mgrURL returns the registered URL of an upstream (helper for re-registering it).
func (e *env) mgrURL(t *testing.T, name string) string {
	t.Helper()
	return e.urls[name]
}

func TestRateLimit(t *testing.T) {
	e := newEnvRate(t, 0.001, 2)
	tok := e.token(t, "a", "*")
	codes := []int{}
	for i := 0; i < 4; i++ {
		codes = append(codes, rawPost(t, e.gw.URL+"/mcp", tok, []byte(listReq)).StatusCode)
	}
	if codes[0] != 200 || codes[1] != 200 || codes[3] != 429 {
		t.Fatalf("codes=%v", codes)
	}
}

func TestHealthz(t *testing.T) {
	e := newEnv(t, 10)
	resp, err := http.Get(e.gw.URL + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", resp, err)
	}
	resp.Body.Close()
}
