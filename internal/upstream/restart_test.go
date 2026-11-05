package upstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync"
	"testing"

	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
)

// forgetful stands in front of a real MCP server and behaves like Hindsight's Python server after a restart:
// a request that carries a session id issued before the restart is answered with HTTP 404 and a JSON-RPC error
// body ("Session not found"), whereas a Go server answers a bare 404 that the SDK reports as ErrSessionMissing.
type forgetful struct {
	mu    sync.Mutex
	epoch int
	seen  map[string]int
	proxy *httputil.ReverseProxy
}

func newForgetful(t *testing.T, target string) *forgetful {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	f := &forgetful{seen: map[string]int{}}
	f.proxy = httputil.NewSingleHostReverseProxy(u)
	f.proxy.FlushInterval = -1 // streamed responses must not be buffered
	f.proxy.ModifyResponse = func(r *http.Response) error {
		if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
			f.mu.Lock()
			f.seen[sid] = f.epoch
			f.mu.Unlock()
		}
		return nil
	}
	return f
}

func (f *forgetful) restart() {
	f.mu.Lock()
	f.epoch++
	f.mu.Unlock()
}

func (f *forgetful) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
		f.mu.Lock()
		epoch, known := f.seen[sid]
		current := f.epoch
		f.mu.Unlock()
		if !known || epoch < current {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}`)
			return
		}
	}
	f.proxy.ServeHTTP(w, r)
}

func TestRecoversWhenTheUpstreamRestartsAndForgetsOurSession(t *testing.T) {
	up := fakemcp.New(t, "", echo())
	front := newForgetful(t, up.URL)
	srv := httptest.NewServer(front)
	defer srv.Close()
	m := newMgr(nil, store.Upstream{Name: "hs", URL: srv.URL, Enabled: true})
	ctx := context.Background()
	call := func() (string, error) {
		res, err := m.Call(ctx, "hs", "echo", json.RawMessage(`{"msg":"hi"}`))
		if err != nil {
			return "", err
		}
		return text(t, res), nil
	}

	if got, err := call(); err != nil || got != "hi" {
		t.Fatalf("before the restart: %q %v", got, err)
	}
	front.restart()
	if got, err := call(); err != nil || got != "hi" {
		t.Fatalf("a call after the upstream restarted must drop the dead session, reconnect and succeed (the nightly backup restarts Hindsight): %q %v", got, err)
	}
	front.restart()
	entries, err := m.Probe(ctx, "hs")
	if err != nil || len(entries) != 1 || entries[0].Tool != "echo" {
		t.Fatalf("listing after another restart must recover too: %v %v", entries, err)
	}
}
