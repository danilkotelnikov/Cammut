package gateway

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
)

func TestBatchBodiesAreRejected(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "a", "*")
	batch := `[` + listReq + `,` + listReq + `]`
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte(batch)); r.StatusCode != 400 {
		t.Fatalf("batch: %d", r.StatusCode)
	}
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte("  \n"+listReq)); r.StatusCode != 200 {
		t.Fatalf("leading whitespace must still work: %d", r.StatusCode)
	}
	if r := rawPost(t, e.gw.URL+"/mcp", tok, nil); r.StatusCode != 400 {
		t.Fatalf("empty body: %d", r.StatusCode)
	}
}

func TestOversizedValidJSONIs413AndServerSurvives(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "a", "*")
	big := `{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"` + strings.Repeat("a", 3<<19) + `"}` // ~1.5 MiB
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte(big)); r.StatusCode != 413 {
		t.Fatalf("oversized: %d", r.StatusCode)
	}
	if r := rawPost(t, e.gw.URL+"/mcp", tok, []byte(listReq)); r.StatusCode != 200 {
		t.Fatalf("after oversized: %d", r.StatusCode)
	}
}

func TestPublicHostBehindReverseProxy(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "a", "*")
	req, _ := http.NewRequest("POST", e.gw.URL+"/mcp", bytes.NewReader([]byte(listReq)))
	req.Host = "cammut.example.org" // what Caddy forwards, arriving from a loopback peer
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("public Host header: %d", resp.StatusCode)
	}
}

func TestBearerSchemeIsCaseInsensitive(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "a", "*")
	for _, scheme := range []string{"bearer", "BEARER", "Bearer"} {
		req, _ := http.NewRequest("POST", e.gw.URL+"/mcp", bytes.NewReader([]byte(listReq)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", scheme+" "+tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d", scheme, resp.StatusCode)
		}
	}
}

func TestRateLimitIsPerToken(t *testing.T) {
	e := newEnvRate(t, 0.001, 2)
	a, b := e.token(t, "a", "*"), e.token(t, "b", "*")
	for i := 0; i < 2; i++ {
		rawPost(t, e.gw.URL+"/mcp", a, []byte(listReq))
	}
	if r := rawPost(t, e.gw.URL+"/mcp", a, []byte(listReq)); r.StatusCode != 429 {
		t.Fatalf("a should be limited: %d", r.StatusCode)
	}
	if r := rawPost(t, e.gw.URL+"/mcp", b, []byte(listReq)); r.StatusCode != 200 {
		t.Fatalf("b must have its own bucket: %d", r.StatusCode)
	}
}

func TestAuditIsBoundedAndHidesUpstreamErrors(t *testing.T) {
	e := newEnv(t, 1000)
	dead := fakemcp.New(t, "", fakemcp.Tool{Name: "x", Description: "gone"})
	deadURL := dead.URL
	dead.Close()
	e.mgr.Set([]store.Upstream{{Name: "alpha", URL: e.urls["alpha"], Enabled: true}, {Name: "dead", URL: deadURL, Enabled: true}})
	cs := e.client(t, e.token(t, "a", "*"))

	huge := strings.Repeat("z", 100_000)
	call(t, cs, "cammut_call", map[string]any{"tool": huge + "/" + huge})
	call(t, cs, "cammut_call", map[string]any{"tool": "dead/x"})

	rows, err := e.st.RecentAudit(5)
	if err != nil || len(rows) < 2 {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	for _, r := range rows {
		if len(r.Upstream) > maxField+3 || len(r.Tool) > maxField+3 {
			t.Fatalf("unbounded audit fields: %d/%d bytes", len(r.Upstream), len(r.Tool))
		}
	}
	// newest first: rows[0] is the dead-upstream failure, whose note must be a fixed word, not raw error text
	if n := rows[0].Note; n != "unavailable" && n != "timeout" {
		t.Fatalf("audit note leaks error text: %q", n)
	}
}

func TestLandingPageIsPublicAndOtherPathsAre404(t *testing.T) {
	e := newEnv(t, 1000)
	resp, err := http.Get(e.gw.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body := new(bytes.Buffer)
	body.ReadFrom(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(body.String(), "Cammut") || strings.Contains(strings.ToLower(body.String()), "cmt_") {
		t.Fatalf("landing: %d %q", resp.StatusCode, body.String())
	}
	if r2, _ := http.Get(e.gw.URL + "/admin"); r2.StatusCode != 404 {
		t.Fatalf("unknown path: %d", r2.StatusCode)
	} else {
		r2.Body.Close()
	}
}
