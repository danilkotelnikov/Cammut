// Package gwenv starts a real gateway over a temporary database with the in-process memory upstream mounted,
// for tests of the memory MCP surface.
package gwenv

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/gateway"
	"cammut/internal/memory"
	"cammut/internal/memoryapi"
	"cammut/internal/memorymcp"
	"cammut/internal/ratelimit"
	"cammut/internal/store"
	"cammut/internal/upstream"
)

type Env struct {
	st  *store.Store
	srv *httptest.Server
	Svc *memory.Service
}

func New(t *testing.T) *Env { return NewWith(t, nil) }

// NewWith is New with a chance to change the gateway's dependencies (clock, limiter, extra routes) before it starts.
func NewWith(t *testing.T, mutate func(*gateway.Deps)) *Env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "g.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc := memory.NewService(memory.NewStore(st.DB(), nil), &memory.Ranker{}, func(a store.Audit) { st.AddAudit(a) }, nil)
	mgr := upstream.NewManager(func(string) string { return "" })
	mgr.SetLocal("memory", memorymcp.Connector(memorymcp.New(svc)))
	deps := gateway.Deps{Store: st, Mgr: mgr, Limiter: ratelimit.New(1000, 1000), Memory: memoryapi.New(svc, nil)}
	if mutate != nil {
		mutate(&deps)
	}
	srv := httptest.NewServer(gateway.Handler(deps))
	t.Cleanup(srv.Close)
	return &Env{st: st, srv: srv, Svc: svc}
}

func (e *Env) Store() *store.Store { return e.st }

// URL is the gateway's base URL.
func (e *Env) URL() string { return e.srv.URL }

func (e *Env) Token(t *testing.T, label string, scopes ...string) string {
	return e.TokenProfile(t, label, "lazy", scopes...)
}

func (e *Env) TokenProfile(t *testing.T, label, profile string, scopes ...string) string {
	t.Helper()
	plain, _, err := e.st.CreateTokenOpts(label, scopes, time.Time{}, profile)
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

func (e *Env) Client(t *testing.T, tok string) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: e.srv.URL + "/mcp", HTTPClient: &http.Client{Transport: bearer{tok}}, DisableStandaloneSSE: true, MaxRetries: -1,
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// Raw calls a tool and returns the whole result.
func (e *Env) Raw(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error %v", tool, err)
	}
	return res
}

// Call calls a tool and returns the text of its first content item.
func (e *Env) Call(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any) string {
	t.Helper()
	res := e.Raw(t, cs, tool, args)
	if len(res.Content) == 0 {
		t.Fatalf("%s: no content", tool)
	}
	return res.Content[0].(*mcp.TextContent).Text
}

// Decode unmarshals the text of a tool result.
func Decode(t *testing.T, text string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatalf("not JSON: %s", text)
	}
	return m
}
