package gateway

import (
	"context"
	"net/http"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type forwarded struct{ tok, xff, spoof string }

func (f forwarded) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+f.tok)
	if f.xff != "" {
		r.Header.Set("X-Forwarded-For", f.xff)
	}
	if f.spoof != "" {
		r.Header.Set("X-Cammut-Client-IP", f.spoof)
	}
	return http.DefaultTransport.RoundTrip(r)
}

func TestAuditRecordsTheProxyChainsClientAndIgnoresSpoofedHeaders(t *testing.T) {
	e := newEnv(t, 1000)
	tok := e.token(t, "a", "*")
	c := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil)
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: e.gw.URL + "/mcp", DisableStandaloneSSE: true, MaxRetries: -1,
		HTTPClient: &http.Client{Transport: forwarded{tok: tok, xff: "198.51.100.7", spoof: "6.6.6.6"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "cammut_call", Arguments: map[string]any{"tool": "beta/ping"}}); err != nil {
		t.Fatal(err)
	}
	rows, _ := e.st.RecentAudit(1)
	if len(rows) != 1 || rows[0].IP != "198.51.100.7" {
		t.Fatalf("audit ip: %+v (the proxy's address must win, a client-sent X-Cammut-Client-IP must be discarded)", rows)
	}
}

func TestAuditIPFallsBackToThePeer(t *testing.T) {
	e := newEnv(t, 1000)
	cs := e.client(t, e.token(t, "b", "*"))
	call(t, cs, "cammut_call", map[string]any{"tool": "beta/ping"})
	rows, _ := e.st.RecentAudit(1)
	if len(rows) != 1 || rows[0].IP != "127.0.0.1" {
		t.Fatalf("a loopback peer without a proxy header is recorded as itself: %+v", rows)
	}
}
