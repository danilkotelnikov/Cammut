package upstream

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/store"
)

// metaEcho is a tiny MCP server whose only tool answers with the _meta it received.
func metaEcho() *mcp.Server {
	srv := mcp.NewServer(&mcp.Implementation{Name: "local", Version: "0"}, nil)
	srv.AddTool(&mcp.Tool{Name: "who", Description: "echo the caller meta", InputSchema: json.RawMessage(`{"type":"object"}`)},
		func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			b, _ := json.Marshal(req.Params.GetMeta())
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil
		})
	return srv
}

func connector(srv *mcp.Server) func(context.Context) (*mcp.ClientSession, error) {
	return func(ctx context.Context) (*mcp.ClientSession, error) {
		ct, st := mcp.NewInMemoryTransports()
		ss, err := srv.Connect(ctx, st, nil)
		if err != nil {
			return nil, err
		}
		cs, err := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil).Connect(ctx, ct, nil)
		if err != nil {
			ss.Close()
			return nil, err
		}
		return cs, nil
	}
}

func localText(t *testing.T, r *mcp.CallToolResult) string {
	t.Helper()
	return r.Content[0].(*mcp.TextContent).Text
}

func TestLocalUpstreamIsListedCalledAndSurvivesSet(t *testing.T) {
	m := NewManager(func(string) string { return "" })
	m.SetLocal("memory", connector(metaEcho()))
	if !m.Has("memory") || strings.Join(m.Names(), ",") != "memory" {
		t.Fatalf("names: %v", m.Names())
	}
	// a database row with the same name does not shadow it, and Set neither drops nor reconnects it
	m.Set([]store.Upstream{{Name: "memory", URL: "http://127.0.0.1:1/mcp", Enabled: true}, {Name: "other", URL: "http://127.0.0.1:1/mcp", Enabled: true}})
	if strings.Join(m.Names(), ",") != "memory,other" {
		t.Fatalf("after Set: %v", m.Names())
	}
	entries, errs := m.Entries(context.Background(), func(n string) bool { return n == "memory" })
	if len(errs) != 0 || len(entries) != 1 || entries[0].Upstream != "memory" || entries[0].Tool != "who" {
		t.Fatalf("entries: %+v %v", entries, errs)
	}
	res, err := m.Call(context.Background(), "memory", "who", nil)
	if err != nil || res.IsError || strings.Contains(localText(t, res), MetaActor) {
		t.Fatalf("call: %+v %v", res, err)
	}
	m.Set(nil)
	if strings.Join(m.Names(), ",") != "memory" {
		t.Fatalf("a local upstream outlives Set(nil): %v", m.Names())
	}
}

func TestCallerMetaReachesLocalUpstreamsOnly(t *testing.T) {
	m := NewManager(func(string) string { return "" })
	m.SetLocal("memory", connector(metaEcho()))
	var mu sync.Mutex
	var remoteSaw map[string]any
	remote := mcp.NewServer(&mcp.Implementation{Name: "remote", Version: "0"}, nil)
	remote.AddTool(&mcp.Tool{Name: "who", InputSchema: json.RawMessage(`{"type":"object"}`)}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		mu.Lock()
		remoteSaw = req.Params.GetMeta()
		mu.Unlock()
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, nil
	})
	ts := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return remote }, nil))
	defer ts.Close()
	m.Set([]store.Upstream{{Name: "remote", URL: ts.URL, Enabled: true}})
	ctx := WithMeta(context.Background(), map[string]any{MetaActor: map[string]any{"label": "cc", "id": 7}})
	res, err := m.Call(ctx, "memory", "who", nil)
	if err != nil || !strings.Contains(localText(t, res), `"label":"cc"`) || !strings.Contains(localText(t, res), MetaActor) {
		t.Fatalf("a local upstream sees the caller: %+v %v", res, err)
	}
	if _, err := m.Call(ctx, "remote", "who", nil); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(remoteSaw) != 0 {
		t.Fatalf("a remote upstream must never learn who called: %v", remoteSaw)
	}
}
