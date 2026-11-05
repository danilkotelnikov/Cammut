// Package fakemcp starts an in-process MCP server for tests.
package fakemcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tool is a canned tool: Run receives the decoded arguments and returns the text result.
// When Fail is set the tool answers with a JSON-RPC protocol error instead (Run still executes first).
type Tool struct {
	Name        string
	Description string
	Run         func(args map[string]any) string
	Fail        string
}

func build(tools []Tool) http.Handler {
	srv := mcp.NewServer(&mcp.Implementation{Name: "fake", Version: "0"}, nil)
	for _, tl := range tools {
		run, fail := tl.Run, tl.Fail
		srv.AddTool(&mcp.Tool{
			Name:        tl.Name,
			Description: tl.Description,
			InputSchema: json.RawMessage(`{"type":"object"}`),
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var args map[string]any
			if len(req.Params.Arguments) > 0 {
				_ = json.Unmarshal(req.Params.Arguments, &args)
			}
			out := ""
			if run != nil {
				out = run(args)
			}
			if fail != "" {
				return nil, errors.New(fail)
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: out}}}, nil
		})
	}
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, nil)
}

// New serves the tools over stateful Streamable HTTP. When bearer is non-empty, requests must send it.
func New(t testing.TB, bearer string, tools ...Tool) *httptest.Server {
	t.Helper()
	ts, _ := NewRestartable(t, bearer, tools...)
	return ts
}

// NewRestartable is New plus a restart func that forgets every session, like an upstream process restart:
// clients holding an old Mcp-Session-Id get 404 until they reconnect.
func NewRestartable(t testing.TB, bearer string, tools ...Tool) (*httptest.Server, func()) {
	t.Helper()
	var h atomic.Pointer[http.Handler]
	set := func() { cur := build(tools); h.Store(&cur) }
	set()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if bearer != "" && r.Header.Get("Authorization") != "Bearer "+bearer {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		(*h.Load()).ServeHTTP(w, r)
	}))
	t.Cleanup(ts.Close)
	return ts, set
}
