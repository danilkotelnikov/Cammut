// Package upstream keeps lazy, self-healing client sessions to HTTP MCP upstreams.
package upstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/index"
	"cammut/internal/store"
	"cammut/internal/version"
)

// maxUpstreamBody bounds one upstream HTTP response so a hostile or broken upstream cannot exhaust memory.
const maxUpstreamBody = 8 << 20

type cached struct {
	at      time.Time
	entries []index.Entry
}

type failure struct {
	at  time.Time
	err error
}

// Manager owns one session per upstream plus a tool-list cache.
type Manager struct {
	getenv      func(string) string
	ttl         time.Duration // how long a tool list stays fresh
	timeout     time.Duration // per tool call
	listTimeout time.Duration // per tool-list refresh
	backoff     time.Duration // skip reconnecting to a failed upstream for this long

	mu       sync.Mutex
	secretFn SecretResolver // resolves named bearer secrets (the vault); nil = environment only
	specs    map[string]store.Upstream
	conns    map[string]*mcp.ClientSession
	cache    map[string]cached
	fails    map[string]failure
	flights  map[string]chan struct{} // tool-list refreshes in progress, closed when done
	locals   map[string]func(context.Context) (*mcp.ClientSession, error)
}

type metaKey struct{}

// MetaActor is the _meta key under which the gateway tells a LOCAL upstream who is calling. It is set only from
// the authenticated token, never from anything the caller sent, and never forwarded to a remote upstream.
const MetaActor = "cammut/actor"

// WithMeta attaches request metadata for local upstreams to ctx.
func WithMeta(ctx context.Context, meta map[string]any) context.Context {
	return context.WithValue(ctx, metaKey{}, meta)
}

func NewManager(getenv func(string) string) *Manager {
	return &Manager{
		getenv: getenv, ttl: time.Minute, timeout: 30 * time.Second, listTimeout: 8 * time.Second, backoff: 10 * time.Second,
		specs: map[string]store.Upstream{}, conns: map[string]*mcp.ClientSession{},
		cache: map[string]cached{}, fails: map[string]failure{}, flights: map[string]chan struct{}{},
		locals: map[string]func(context.Context) (*mcp.ClientSession, error){},
	}
}

// SetLocal mounts an in-process upstream. It is listed by Names/Has like any other, reached through connect instead
// of HTTP, survives Set, and wins over a stored upstream of the same name.
func (m *Manager) SetLocal(name string, connect func(ctx context.Context) (*mcp.ClientSession, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.locals[name] = connect
	m.specs[name] = store.Upstream{Name: name, URL: "local:" + name, Enabled: true}
}

// Set replaces the enabled upstream set. Sessions to removed or changed upstreams are closed.
func (m *Manager) Set(ups []store.Upstream) {
	next := map[string]store.Upstream{}
	for _, u := range ups {
		if u.Enabled {
			next[u.Name] = u
		}
	}
	m.mu.Lock()
	for name := range m.locals {
		next[name] = m.specs[name]
	}
	var stale []*mcp.ClientSession
	for name, old := range m.specs {
		if cur, ok := next[name]; !ok || cur != old {
			if cs := m.conns[name]; cs != nil {
				stale = append(stale, cs)
			}
			delete(m.conns, name)
			delete(m.cache, name)
			delete(m.fails, name)
			delete(m.flights, name) // the old refresh discards its result (spec mismatch); the next list starts afresh
		}
	}
	m.specs = next
	m.mu.Unlock()
	for _, cs := range stale {
		go cs.Close()
	}
}

func (m *Manager) Names() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.specs))
	for n := range m.specs {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func (m *Manager) Has(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.specs[name]
	return ok
}

// ErrSecretNotAllowed: the secret exists but its purpose or host list does not allow this destination.
// The request fails closed: there is no unauthenticated or environment fallback.
var ErrSecretNotAllowed = errors.New("secret not allowed for host")

// SecretResolver returns the value of a named secret for (purpose, host). It returns ("", nil) when the secret does
// not exist, and ErrSecretNotAllowed when it exists but may not go to this host.
type SecretResolver func(name, purpose, host string) (string, error)

// PurposeBearer is the vault purpose a bearer secret must carry.
const PurposeBearer = "mcp-upstream-bearer"

// SetSecretResolver tells the manager where named bearer secrets live (the vault). Without one, or when it
// has no value, the upstream's environment variable is used.
func (m *Manager) SetSecretResolver(f SecretResolver) {
	m.mu.Lock()
	m.secretFn = f
	m.mu.Unlock()
}

func (m *Manager) resolveSecret(name, host string) (string, error) {
	m.mu.Lock()
	f := m.secretFn
	m.mu.Unlock()
	if f == nil {
		return "", nil
	}
	return f(name, PurposeBearer, host)
}

// Probe lists the upstream's tools with a fresh connection attempt, ignoring and not touching the cache.
func (m *Manager) Probe(ctx context.Context, name string) ([]index.Entry, error) {
	return m.fetch(ctx, name)
}

// bearerRT adds the upstream secret, read at request time, and only for the upstream's own host.
type bearerRT struct {
	host     string
	secret   string
	secretFn func(name, host string) (string, error)
	env      string
	getenv   func(string) string
	header   string // "" means "Authorization: Bearer <key>"; otherwise the bare key goes in this header
	next     http.RoundTripper
}

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host == b.host {
		v := ""
		if b.secret != "" && b.secretFn != nil {
			var err error
			// Checked on every request, so a changed policy applies to live sessions at once.
			if v, err = b.secretFn(b.secret, r.URL.Hostname()); err != nil {
				return nil, err
			}
		}
		if v == "" && b.env != "" {
			v = b.getenv(b.env)
		}
		if v != "" {
			r = r.Clone(r.Context())
			if b.header != "" {
				r.Header.Set(b.header, v)
			} else {
				r.Header.Set("Authorization", "Bearer "+v)
			}
		}
	}
	return b.next.RoundTrip(r)
}

// limitRT caps every upstream response body.
type limitRT struct{ next http.RoundTripper }

func (l limitRT) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := l.next.RoundTrip(r)
	if err == nil {
		resp.Body = http.MaxBytesReader(nil, resp.Body, maxUpstreamBody)
	}
	return resp, err
}

// httpClient builds the client for one upstream: bounded dial and header waits (so a black-holed upstream
// cannot pin a connect forever), no redirects (so the bearer cannot be steered to another host), capped bodies.
func (m *Manager) httpClient(spec store.Upstream) *http.Client {
	host := ""
	if u, err := url.Parse(spec.URL); err == nil {
		host = u.Host
	}
	tr := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: m.timeout + 5*time.Second,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConnsPerHost:   4,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport:     limitRT{bearerRT{host: host, secret: spec.BearerSecret, secretFn: m.resolveSecret, env: spec.BearerEnv, getenv: m.getenv, header: spec.AuthHeader, next: tr}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// session returns the live session for name, connecting if needed. The session is detached from
// ctx cancellation so it outlives the call that created it; ctx still bounds the wait.
func (m *Manager) session(ctx context.Context, name string) (*mcp.ClientSession, error) {
	m.mu.Lock()
	spec, ok := m.specs[name]
	cs := m.conns[name]
	local := m.locals[name]
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("unknown upstream %q", name)
	}
	if cs != nil {
		return cs, nil
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "cammut", Version: version.Version}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:             spec.URL,
		HTTPClient:           m.httpClient(spec),
		DisableStandaloneSSE: true,
		MaxRetries:           -1,
	}
	type result struct {
		cs  *mcp.ClientSession
		err error
	}
	ch := make(chan result, 1)
	go func() {
		var c *mcp.ClientSession
		var err error
		if local != nil {
			c, err = local(context.WithoutCancel(ctx))
		} else {
			c, err = client.Connect(context.WithoutCancel(ctx), transport, nil)
		}
		ch <- result{c, err}
	}()
	var r result
	select {
	case r = <-ch:
	case <-ctx.Done():
		go func() {
			if late := <-ch; late.cs != nil {
				late.cs.Close()
			}
		}()
		return nil, fmt.Errorf("connect %s: %w", name, ctx.Err())
	}
	if r.err != nil {
		return nil, fmt.Errorf("connect %s: %w", name, r.err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur := m.conns[name]; cur != nil {
		go r.cs.Close()
		return cur, nil
	}
	if m.specs[name] != spec {
		go r.cs.Close()
		return nil, fmt.Errorf("upstream %q changed while connecting", name)
	}
	m.conns[name] = r.cs
	return r.cs, nil
}

func (m *Manager) drop(name string, cs *mcp.ClientSession) {
	m.mu.Lock()
	if m.conns[name] == cs {
		delete(m.conns, name)
	}
	m.mu.Unlock()
	go cs.Close()
}

// detach returns a context that carries none of parent's values but still ends when parent ends or after
// timeout. Values must not leak: the SDK stores the protocol version negotiated with the *incoming* client
// in the request context, and reusing it would make us propose that version to every upstream.
func detach(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	stop := context.AfterFunc(parent, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

// errRejected matches the SDK's "rejected by transport" error (code -32005). The SDK wraps in it every failure
// that happened below the tool: a refused connection, a transient HTTP status, or a server that no longer knows
// our session. It is itself a JSON-RPC error, which is why it must be told apart from an answer by the tool.
var errRejected = &jsonrpc.Error{Code: -32005}

// answered reports whether err is a JSON-RPC error the upstream's tool itself sent: the session is healthy and
// the request reached the tool, so it must be neither retried nor the session dropped. A transport rejection
// is not an answer.
func answered(err error) bool {
	var je *jsonrpc.Error
	return errors.As(err, &je) && !errors.Is(err, errRejected)
}

// sessionGone reports that the upstream no longer knows our session (it restarted or expired it). The MCP spec
// says it then answers 404 to a request carrying that session id. A Go server's bare 404 reaches us as
// ErrSessionMissing; Hindsight's Python server sends a JSON-RPC error body with the 404, which the SDK reports
// as a transport rejection ending in the status text.
func sessionGone(err error) bool {
	return errors.Is(err, mcp.ErrSessionMissing) ||
		(errors.Is(err, errRejected) && strings.HasSuffix(err.Error(), http.StatusText(http.StatusNotFound)))
}

// notSent reports failures where the request provably never ran upstream (the session was already gone,
// or the connection was never made), the only case where repeating a tool call cannot repeat side effects.
func notSent(err error) bool {
	var oe *net.OpError
	return sessionGone(err) || errors.Is(err, mcp.ErrConnectionClosed) || (errors.As(err, &oe) && oe.Op == "dial")
}

// Call invokes one upstream tool. If the session turned out to be dead before the request was sent, it
// reconnects and retries once; any other failure is returned as is, because a retry could run the tool twice.
func (m *Manager) Call(ctx context.Context, up, tool string, args json.RawMessage) (*mcp.CallToolResult, error) {
	meta, _ := ctx.Value(metaKey{}).(map[string]any)
	m.mu.Lock()
	_, local := m.locals[up]
	m.mu.Unlock()
	ctx, cancel := detach(ctx, m.timeout)
	defer cancel()
	var arguments any
	if len(args) > 0 && string(args) != "null" {
		arguments = args
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		cs, err := m.session(ctx, up)
		if err != nil {
			return nil, err
		}
		params := &mcp.CallToolParams{Name: tool, Arguments: arguments}
		if local && meta != nil {
			params.Meta = mcp.Meta(meta)
		}
		res, err := cs.CallTool(ctx, params)
		if err == nil {
			return res, nil
		}
		if ctx.Err() != nil || answered(err) {
			return nil, err
		}
		m.drop(up, cs) // transport failure: this session is no good for anyone
		if !notSent(err) {
			return nil, err
		}
		lastErr = err
	}
	return nil, lastErr
}

// Entries lists the tools of every upstream that visible accepts (nil = all), in parallel. Cached lists are
// returned at once, even when stale; a refresh runs in the background. An upstream whose last refresh failed
// appears in the error map even if its stale tools are still returned.
func (m *Manager) Entries(ctx context.Context, visible func(string) bool) ([]index.Entry, map[string]error) {
	var names []string
	for _, n := range m.Names() {
		if visible == nil || visible(n) {
			names = append(names, n)
		}
	}
	type r struct {
		name string
		e    []index.Entry
		err  error
	}
	ch := make(chan r, len(names))
	for _, n := range names {
		go func(n string) {
			e, err := m.list(ctx, n)
			ch <- r{n, e, err}
		}(n)
	}
	var all []index.Entry
	errs := map[string]error{}
	for range names {
		x := <-ch
		all = append(all, x.e...)
		if x.err != nil {
			errs[x.name] = x.err
		}
	}
	return all, errs
}

func (m *Manager) list(ctx context.Context, name string) ([]index.Entry, error) {
	m.mu.Lock()
	c, haveCache := m.cache[name]
	f, failed := m.fails[name]
	var lastErr error
	if failed {
		lastErr = f.err
	}
	mayFetch := !failed || time.Since(f.at) >= m.backoff
	if haveCache {
		if (failed || time.Since(c.at) >= m.ttl) && mayFetch {
			m.refresh(name)
		}
		m.mu.Unlock()
		return c.entries, lastErr
	}
	if !mayFetch {
		m.mu.Unlock()
		return nil, lastErr
	}
	done := m.refresh(name)
	m.mu.Unlock()
	select {
	case <-done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cache[name]; ok {
		return c.entries, nil
	}
	if f, ok := m.fails[name]; ok {
		return nil, f.err
	}
	return nil, fmt.Errorf("upstream %q changed while listing", name)
}

// refresh starts (or joins) the single background tool-list fetch for name. The caller holds m.mu.
func (m *Manager) refresh(name string) <-chan struct{} {
	if done, ok := m.flights[name]; ok {
		return done
	}
	done := make(chan struct{})
	m.flights[name] = done
	spec := m.specs[name]
	go func() {
		entries, err := m.fetch(context.Background(), name)
		m.mu.Lock()
		defer m.mu.Unlock()
		defer close(done)
		if m.flights[name] == done {
			delete(m.flights, name)
		}
		if m.specs[name] != spec {
			return // replaced or removed while fetching; the result describes the old upstream
		}
		if err != nil {
			m.fails[name] = failure{time.Now(), err}
			return
		}
		delete(m.fails, name)
		m.cache[name] = cached{time.Now(), entries}
	}()
	return done
}

func (m *Manager) fetch(ctx context.Context, name string) ([]index.Entry, error) {
	ctx, cancel := detach(ctx, m.listTimeout)
	defer cancel()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		cs, err := m.session(ctx, name)
		if err != nil {
			return nil, err
		}
		var out []index.Entry
		var ferr error
		for t, err := range cs.Tools(ctx, nil) {
			if err != nil {
				ferr = err
				break
			}
			if t.Name == "" {
				continue
			}
			schema, _ := json.Marshal(t.InputSchema)
			out = append(out, index.Entry{Upstream: name, Tool: t.Name, Description: t.Description, Schema: schema})
		}
		if ferr == nil {
			return out, nil
		}
		if ctx.Err() != nil || answered(ferr) {
			return nil, ferr
		}
		lastErr = ferr // listing is read-only, so any transport failure may be retried on a fresh session
		m.drop(name, cs)
	}
	return nil, lastErr
}
