package upstream

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"cammut/internal/store"
)

type recorder struct {
	*httptest.Server
	mu   sync.Mutex
	auth []string
	n    atomic.Int64
}

func newRecorder(t *testing.T, redirectTo string) *recorder {
	t.Helper()
	r := &recorder{}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.n.Add(1)
		r.mu.Lock()
		r.auth = append(r.auth, req.Header.Get("Authorization"))
		r.mu.Unlock()
		if redirectTo != "" {
			http.Redirect(w, req, redirectTo, http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *recorder) sawAuthorization() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.auth {
		if a != "" {
			return true
		}
	}
	return false
}

func hostOf(raw string) string {
	u, _ := url.Parse(raw)
	return u.Hostname()
}

// policyRes is a resolver with a live, mutable host list, like the vault.
type policyRes struct {
	mu    sync.Mutex
	value string
	hosts map[string]bool
}

func (p *policyRes) resolve(name, purpose, host string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if purpose != PurposeBearer || !p.hosts[host] {
		return "", ErrSecretNotAllowed
	}
	return p.value, nil
}

func (p *policyRes) setHosts(h ...string) {
	p.mu.Lock()
	p.hosts = map[string]bool{}
	for _, x := range h {
		p.hosts[x] = true
	}
	p.mu.Unlock()
}

func TestBearerIsCheckedOnEveryRequestAndNeverFollowsARedirect(t *testing.T) {
	evil := newRecorder(t, "")
	good := newRecorder(t, evil.URL+"/steal")
	res := &policyRes{value: "ghp_x"}
	res.setHosts(hostOf(good.URL)) // both servers are 127.0.0.1: the host list is by name
	m := NewManager(func(string) string { return "" })
	m.SetSecretResolver(res.resolve)
	m.Set([]store.Upstream{{Name: "gh", URL: good.URL + "/mcp", BearerSecret: "GITHUB_PAT", Enabled: true}})
	m.Probe(context.Background(), "gh")
	if good.n.Load() == 0 || !good.sawAuthorization() {
		t.Fatalf("the listed host must get the bearer (requests=%d)", good.n.Load())
	}
	if evil.n.Load() != 0 {
		t.Fatalf("a redirect must not be followed at all: %d requests", evil.n.Load())
	}

	// the same secret on a host that is NOT on its list is refused before any request leaves
	other := newRecorder(t, "")
	res.setHosts("somewhere.example")
	m.Set([]store.Upstream{{Name: "o", URL: other.URL + "/mcp", BearerSecret: "GITHUB_PAT", Enabled: true}})
	_, err := m.Probe(context.Background(), "o")
	if err == nil || !strings.Contains(err.Error(), "secret not allowed for host") || other.sawAuthorization() || other.n.Load() != 0 {
		t.Fatalf("fail closed before any request leaves: %v requests=%d", err, other.n.Load())
	}
	if strings.Contains(err.Error(), "GITHUB_PAT") || strings.Contains(err.Error(), "ghp_x") {
		t.Fatalf("the refusal must not name the secret: %v", err)
	}

	// policy changes apply to live upstreams on the next request (checked per request, not per session)
	res.setHosts(hostOf(good.URL))
	before := good.n.Load()
	m.Set([]store.Upstream{{Name: "gh", URL: good.URL + "/mcp", BearerSecret: "GITHUB_PAT", Enabled: true}})
	m.Probe(context.Background(), "gh")
	if good.n.Load() == before {
		t.Fatal("setup: the listed host must be reachable again")
	}
	res.setHosts()
	n := good.n.Load()
	if _, err := m.Probe(context.Background(), "gh"); err == nil || good.n.Load() != n {
		t.Fatalf("removing the host from the list must stop transmissions immediately: %v (+%d requests)", err, good.n.Load()-n)
	}
}
