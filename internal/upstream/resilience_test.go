package upstream

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"cammut/internal/index"
	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
)

func TestProtocolErrorIsNotRetriedAndKeepsSession(t *testing.T) {
	var runs atomic.Int32
	ts := fakemcp.New(t, "", fakemcp.Tool{Name: "boom", Description: "always fails", Fail: "bad params",
		Run: func(map[string]any) string { runs.Add(1); return "" }})
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	if _, err := m.Call(context.Background(), "fake", "boom", nil); err == nil {
		t.Fatal("expected the protocol error")
	}
	if n := runs.Load(); n != 1 {
		t.Fatalf("tool ran %d times; a retry would repeat its side effects", n)
	}
	m.mu.Lock()
	first := m.conns["fake"]
	m.mu.Unlock()
	if first == nil {
		t.Fatal("an upstream's own error must not drop the shared session")
	}
	_, _ = m.Call(context.Background(), "fake", "boom", nil)
	m.mu.Lock()
	same := m.conns["fake"] == first
	m.mu.Unlock()
	if !same {
		t.Fatal("session was replaced after a protocol error")
	}
}

func TestRedirectsAreNotFollowedAndBearerStaysHome(t *testing.T) {
	var hits atomic.Int32
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	t.Cleanup(evil.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/mcp", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)
	m := newMgr(map[string]string{"KEY": "s3cret"}, store.Upstream{Name: "r", URL: redirector.URL, BearerEnv: "KEY", Enabled: true})
	if _, err := m.Call(context.Background(), "r", "x", nil); err == nil {
		t.Fatal("a redirecting upstream must fail, not be followed")
	}
	if hits.Load() != 0 {
		t.Fatalf("redirect was followed (%d hits)", hits.Load())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestBearerOnlyGoesToTheUpstreamHost(t *testing.T) {
	var seen string
	next := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		seen = r.Header.Get("Authorization")
		return &http.Response{StatusCode: 200, Body: http.NoBody, Request: r}, nil
	})
	rt := bearerRT{host: "up.example:443", env: "K", getenv: func(string) string { return "tok" }, next: next}
	for _, c := range []struct{ url, want string }{{"https://up.example:443/mcp", "Bearer tok"}, {"https://other.example/mcp", ""}} {
		seen = ""
		req, _ := http.NewRequest("POST", c.url, nil)
		if _, err := rt.RoundTrip(req); err != nil || seen != c.want {
			t.Fatalf("%s: seen=%q want %q err=%v", c.url, seen, c.want, err)
		}
	}
}

// blackHole accepts TCP connections and never answers.
func blackHole(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		l.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
	})
	return "http://" + l.Addr().String() + "/mcp"
}

func TestBlackHoledUpstreamNeverStallsListing(t *testing.T) {
	url := blackHole(t)
	m := newMgr(nil, store.Upstream{Name: "bh", URL: url, Enabled: true})
	m.listTimeout = 300 * time.Millisecond

	// no cache yet: the wait is bounded by listTimeout, then the failure is remembered
	start := time.Now()
	if _, errs := m.Entries(context.Background(), nil); errs["bh"] == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("errs=%v after %v", errs, time.Since(start))
	}

	// stale cache: answered at once from the cache while the refresh hangs in the background
	m.mu.Lock()
	m.cache["bh"] = cached{at: time.Now().Add(-time.Hour), entries: []index.Entry{{Upstream: "bh", Tool: "t"}}}
	delete(m.fails, "bh")
	m.mu.Unlock()
	start = time.Now()
	entries, errs := m.Entries(context.Background(), nil)
	if len(entries) != 1 || errs["bh"] != nil || time.Since(start) > 150*time.Millisecond {
		t.Fatalf("entries=%v errs=%v after %v", entries, errs, time.Since(start))
	}

	// once the background refresh has failed, the stale tools are still served but health turns red
	deadline := time.Now().Add(3 * time.Second)
	for {
		entries, errs = m.Entries(context.Background(), nil)
		if errs["bh"] != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("failed refresh never surfaced in the error map")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(entries) != 1 {
		t.Fatalf("stale tools must survive a failed refresh, got %v", entries)
	}
}

func TestHiddenUpstreamsAreNotContacted(t *testing.T) {
	url := blackHole(t)
	good := fakemcp.New(t, "", echo())
	m := newMgr(nil, store.Upstream{Name: "bh", URL: url, Enabled: true}, store.Upstream{Name: "good", URL: good.URL, Enabled: true})
	start := time.Now()
	entries, errs := m.Entries(context.Background(), func(n string) bool { return n == "good" })
	if len(entries) != 1 || len(errs) != 0 || time.Since(start) > 2*time.Second {
		t.Fatalf("entries=%v errs=%v after %v", entries, errs, time.Since(start))
	}
}

func TestSetWithChangedURLSwitchesUpstream(t *testing.T) {
	a := fakemcp.New(t, "", fakemcp.Tool{Name: "from-a", Description: "a", Run: func(map[string]any) string { return "A" }})
	b := fakemcp.New(t, "", fakemcp.Tool{Name: "from-b", Description: "b", Run: func(map[string]any) string { return "B" }})
	m := newMgr(nil, store.Upstream{Name: "u", URL: a.URL, Enabled: true})
	if e, _ := m.Entries(context.Background(), nil); len(e) != 1 || e[0].Tool != "from-a" {
		t.Fatalf("before: %+v", e)
	}
	m.Set([]store.Upstream{{Name: "u", URL: b.URL, Enabled: true}})
	e, errs := m.Entries(context.Background(), nil)
	if len(errs) != 0 || len(e) != 1 || e[0].Tool != "from-b" {
		t.Fatalf("after: %+v %v", e, errs)
	}
	if res, err := m.Call(context.Background(), "u", "from-b", nil); err != nil || text(t, res) != "B" {
		t.Fatalf("call after switch: %v %v", res, err)
	}
}

func TestStaleListIsServedAndOutageIsReported(t *testing.T) {
	ts := fakemcp.New(t, "", echo())
	m := newMgr(nil, store.Upstream{Name: "u", URL: ts.URL, Enabled: true})
	if e, errs := m.Entries(context.Background(), nil); len(e) != 1 || len(errs) != 0 {
		t.Fatalf("warm-up: %v %v", e, errs)
	}
	ts.Close()
	m.mu.Lock()
	m.ttl = 0 // every list is stale from now on
	m.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for {
		e, errs := m.Entries(context.Background(), nil)
		if len(e) != 1 {
			t.Fatalf("stale tools vanished: %v", e)
		}
		if errs["u"] != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("outage never reported although the cache is stale")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestUpstreamRestartIsRecoveredWithoutRunningTheToolTwice(t *testing.T) {
	var runs atomic.Int32
	ts, restart := fakemcp.NewRestartable(t, "", fakemcp.Tool{Name: "bump", Description: "counts runs",
		Run: func(map[string]any) string { runs.Add(1); return "ok" }})
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	if _, err := m.Call(context.Background(), "fake", "bump", nil); err != nil {
		t.Fatal(err)
	}
	restart() // the old Mcp-Session-Id now draws a 404
	if res, err := m.Call(context.Background(), "fake", "bump", nil); err != nil || text(t, res) != "ok" {
		t.Fatalf("expected a transparent reconnect after the upstream restarted: %v %v", res, err)
	}
	if n := runs.Load(); n != 2 {
		t.Fatalf("tool ran %d times for 2 calls", n)
	}
}
