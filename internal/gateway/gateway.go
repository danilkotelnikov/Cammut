// Package gateway is Cammut's public MCP front door: bearer auth, rate limiting and four meta-tools.
package gateway

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/acl"
	"cammut/internal/auth"
	"cammut/internal/clientip"
	"cammut/internal/index"
	"cammut/internal/ratelimit"
	"cammut/internal/store"
	"cammut/internal/upstream"
	"cammut/internal/version"
)

const (
	maxBody   = 1 << 20
	maxResult = 1 << 20
	maxField  = 64 // longest upstream/tool name written to the audit log
	notFound  = "tool not found or not permitted"
)

// Deps are the gateway's collaborators.
type Deps struct {
	Store   *store.Store
	Mgr     *upstream.Manager
	Limiter *ratelimit.Limiter
	Now     func() time.Time
	Log     *slog.Logger
	Admin   http.Handler // the console API; nil leaves the paths unmounted
	Console http.Handler // the embedded UI
	Archive http.Handler // /v1/archive/, mounted behind the bearer check; nil leaves the paths unmounted
	Memory  http.Handler // /v1/memory/, mounted behind the bearer check; nil leaves the paths unmounted
	// Throttle slows client addresses that keep presenting invalid tokens; nil means the defaults of auth.NewThrottle.
	Throttle *auth.Throttle
	OAuth    http.Handler // /.well-known/ and /oauth/, open (the client has no token yet); nil leaves the paths unmounted

	// PublicURL is the public origin. When set, a 401 names the OAuth metadata document so a client can find out how to sign in.
	PublicURL string
}

//go:embed web/index.html
var indexHTML []byte

type tokenKey struct{}

// TokenFrom returns the authenticated token of a request that passed through the gateway's bearer check.
func TokenFrom(ctx context.Context) (store.Token, bool) {
	tok, ok := ctx.Value(tokenKey{}).(store.Token)
	return tok, ok
}

// Handler serves /mcp (authenticated) and /healthz.
func Handler(d Deps) http.Handler {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Throttle == nil {
		d.Throttle = auth.NewThrottle(d.Now)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(indexHTML)
	})
	if d.Admin != nil {
		mux.Handle("/api/v1/", d.Admin)
		mux.Handle("/auth/", d.Admin)
	}
	if d.Console != nil {
		mux.Handle("/console/", d.Console)
	}
	if d.OAuth != nil {
		mux.Handle("/.well-known/", d.OAuth)
		mux.Handle("/oauth/", d.OAuth)
	}
	if d.Archive != nil {
		mux.Handle("/v1/archive/", authenticate(d, d.Archive))
	}
	if d.Memory != nil {
		mux.Handle("/v1/memory/", authenticate(d, d.Memory))
	}
	h := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		tok, ok := r.Context().Value(tokenKey{}).(store.Token)
		if !ok {
			return nil
		}
		return newServer(r.Context(), d, tok)
	}, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		// A reverse proxy (Caddy) forwards the public Host from a loopback peer, which the SDK's DNS-rebinding
		// guard would reject. The bearer token is the gate here, and browsers never hold one.
		DisableLocalhostProtection: true,
	})
	mux.Handle("/mcp", mcpFront(authenticate(d, h)))
	return mux
}

// mcpFront is what every /mcp response and request passes through, authenticated or not. Replies are never cached
// or sniffed, and no CORS header is ever set: browsers get nothing, the endpoint is for server-side clients.
// The SDK insists that a POST's Accept name both application/json and text/event-stream (as the spec says clients
// must); cloud callers are not always that careful and we only ever answer with plain JSON, so a missing or partial
// Accept is completed instead of being turned into a 400.
func mcpFront(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			r.Header.Set("Accept", "application/json, text/event-stream")
		}
		next.ServeHTTP(&noStore{ResponseWriter: w}, r)
	})
}

// noStore stamps the cache and sniffing headers at the moment the status line is written, because the SDK sets its
// own Cache-Control ("no-cache") on the replies it produces.
type noStore struct {
	http.ResponseWriter
	wrote bool
}

func (w *noStore) WriteHeader(code int) {
	if !w.wrote {
		w.wrote = true
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *noStore) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK) // the implicit status line must carry our headers too
	}
	return w.ResponseWriter.Write(b)
}

func (w *noStore) Flush() { http.NewResponseController(w.ResponseWriter).Flush() }

func (w *noStore) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// bearerToken extracts the token from an Authorization header; the scheme is case-insensitive (RFC 7235).
func bearerToken(h string) (string, bool) {
	const p = "Bearer "
	if len(h) <= len(p) || !strings.EqualFold(h[:len(p)], p) {
		return "", false
	}
	tok := strings.TrimSpace(h[len(p):])
	return tok, tok != ""
}

// checkToken verifies a plaintext token and takes one rate-limit credit; it answers the failure itself. A client
// address that is known and not loopback is slowed after repeated invalid tokens. Loopback means the SSH tunnel or a
// proxy that does not forward the client: slowing it would lock the owner out, so it is exempt (tokens are 256-bit;
// the per-token rate limit still applies).
func checkToken(d Deps, w http.ResponseWriter, r *http.Request, plain string) (store.Token, bool) {
	ip := clientip.FromRequest(r)
	tracked := !isLoopback(ip)
	if tracked {
		if wait, allowed := d.Throttle.Check(ip); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
			http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
			return store.Token{}, false
		}
	}
	tok, valid, err := d.Store.VerifyToken(plain)
	if err != nil {
		d.Log.Error("verify token", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return tok, false
	}
	if !valid {
		if tracked {
			d.Throttle.Fail(ip)
			d.Log.Warn("invalid token", "ip", ip, "path", r.URL.Path) // never the token itself
		}
		unauthorized(w, d.PublicURL)
		return tok, false
	}
	if !d.Limiter.Allow(tok.ID, d.Now()) {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return tok, false
	}
	return tok, true
}

func authenticate(d Deps, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plain, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok {
			unauthorized(w, d.PublicURL)
			return
		}
		tok, ok := checkToken(d, w, r, plain)
		if !ok {
			return
		}
		if r.Method == http.MethodPost {
			// One POST must be one JSON-RPC message: a batch array would let a token run many calls on one
			// rate-limit credit. Reading the body here also gives oversized requests a clean 413.
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
				return
			}
			if err != nil {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if b := bytes.TrimLeft(body, " \t\r\n"); len(b) == 0 || b[0] != '{' {
				http.Error(w, "batch requests are not supported", http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		// Our own value, derived from the connection: whatever the client sent under this name is discarded.
		r.Header.Del("X-Cammut-Client-IP")
		r.Header.Set("X-Cammut-Client-IP", clientip.FromRequest(r))
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), tokenKey{}, tok)))
	})
}

func isLoopback(ip string) bool {
	p := net.ParseIP(ip)
	return p == nil || p.IsLoopback()
}

func unauthorized(w http.ResponseWriter, publicURL string) {
	challenge := `Bearer realm="cammut"`
	if publicURL != "" {
		challenge += `, resource_metadata="` + strings.TrimRight(publicURL, "/") + `/.well-known/oauth-protected-resource"`
	}
	w.Header().Set("WWW-Authenticate", challenge)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

type session struct {
	d   Deps
	tok store.Token
}

func newServer(ctx context.Context, d Deps, tok store.Token) *mcp.Server {
	s := &session{d: d, tok: tok}
	srv := mcp.NewServer(&mcp.Implementation{Name: "cammut", Version: version.Version}, nil)
	srv.AddReceivingMiddleware(s.auditing)
	if up, ok := strings.CutPrefix(tok.Profile, "direct:"); ok {
		s.addDirectTools(ctx, srv, up)
		return srv
	}
	srv.AddTool(&mcp.Tool{
		Name:        "cammut_servers",
		Description: "List the upstream MCP servers you may use, with health and tool counts.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
	}, s.servers)
	srv.AddTool(&mcp.Tool{
		Name:        "cammut_search",
		Description: "Find tools across all upstreams by keywords. Tool descriptions are English, so search in English. Returns tool keys like server/tool.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50}}}`),
	}, s.search)
	srv.AddTool(&mcp.Tool{
		Name:        "cammut_describe",
		Description: "Return the description and JSON input schema of one tool (key: server/tool).",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"tool":{"type":"string"}},"required":["tool"]}`),
	}, s.describe)
	srv.AddTool(&mcp.Tool{
		Name:        "cammut_call",
		Description: "Call one tool (key: server/tool) with a JSON arguments object. Use cammut_describe first for the schema.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"tool":{"type":"string"},"arguments":{"type":"object"}},"required":["tool"]}`),
	}, s.call)
	return srv
}

func (s *session) allow(e index.Entry) bool { return acl.Allowed(s.tok.Scopes, e.Upstream, e.Tool) }

func (s *session) visible(name string) bool { return acl.UpstreamVisible(s.tok.Scopes, name) }

func (s *session) servers(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	entries, errs := s.d.Mgr.Entries(ctx, s.visible)
	counts := map[string]int{}
	for _, e := range entries {
		if s.allow(e) {
			counts[e.Upstream]++
		}
	}
	type row struct {
		Name   string `json:"name"`
		Status string `json:"status"`
		Tools  int    `json:"tools"`
	}
	rows := []row{}
	for _, n := range s.d.Mgr.Names() {
		if !s.visible(n) {
			continue
		}
		status := "ok"
		if errs[n] != nil {
			status = "unreachable"
		}
		rows = append(rows, row{n, status, counts[n]})
	}
	return jsonText(rows), nil
}

func (s *session) search(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := parseArgs(req, &a); err != nil {
		return fail("invalid arguments: " + err.Error()), nil
	}
	if a.Limit <= 0 {
		a.Limit = 10
	}
	if a.Limit > 50 {
		a.Limit = 50
	}
	entries, _ := s.d.Mgr.Entries(ctx, s.visible)
	hits := index.New(entries).Search(a.Query, a.Limit, s.allow)
	type row struct {
		Tool        string `json:"tool"`
		Description string `json:"description"`
	}
	rows := make([]row, 0, len(hits))
	for _, h := range hits {
		rows = append(rows, row{h.Key(), clip(h.Description, 240)})
	}
	return jsonText(rows), nil
}

func (s *session) describe(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Tool string `json:"tool"`
	}
	if err := parseArgs(req, &a); err != nil {
		return fail("invalid arguments: " + err.Error()), nil
	}
	up, tool, ok := strings.Cut(a.Tool, "/")
	if !ok || up == "" || tool == "" {
		return fail(notFound), nil
	}
	entries, _ := s.d.Mgr.Entries(ctx, s.visible)
	for _, e := range entries {
		if e.Upstream == up && e.Tool == tool && s.allow(e) {
			schema := e.Schema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			return jsonText(map[string]any{"tool": e.Key(), "description": e.Description, "inputSchema": schema}), nil
		}
	}
	return fail(notFound), nil
}

func (s *session) call(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var a struct {
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := parseArgs(req, &a); err != nil {
		return fail("invalid arguments: " + err.Error()), nil
	}
	up, tool, ok := strings.Cut(a.Tool, "/")
	if !ok || up == "" || tool == "" || !acl.Allowed(s.tok.Scopes, up, tool) || !s.d.Mgr.Has(up) {
		s.note(ctx, up, tool, false, 0, "denied, malformed or unknown")
		return fail(notFound), nil
	}
	return s.invoke(ctx, req, up, tool, a.Arguments)
}

// invoke runs one upstream tool for the session's token and audits it. For a local upstream the caller's identity
// travels in _meta, taken from the authenticated token only.
func (s *session) invoke(ctx context.Context, req *mcp.CallToolRequest, up, tool string, args json.RawMessage) (*mcp.CallToolResult, error) {
	if len(args) > 0 && string(args) != "null" && !isObject(args) {
		return fail("arguments must be a JSON object"), nil
	}
	ip := ""
	if req != nil && req.Extra != nil && req.Extra.Header != nil {
		ip = req.Extra.Header.Get("X-Cammut-Client-IP")
	}
	ctx = upstream.WithMeta(ctx, map[string]any{upstream.MetaActor: map[string]any{"label": s.tok.Label, "id": s.tok.ID, "ip": ip}})
	start := time.Now()
	res, err := s.d.Mgr.Call(ctx, up, tool, args)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		s.d.Log.Warn("upstream call failed", "upstream", clip(up, maxField), "tool", clip(tool, maxField), "err", clip(err.Error(), 200))
		s.note(ctx, up, tool, false, ms, errKind(err))
		return fail("upstream call failed: " + errKind(err)), nil
	}
	if b, _ := json.Marshal(res); len(b) > maxResult {
		s.note(ctx, up, tool, false, ms, "result too large")
		return fail("result too large"), nil
	}
	s.note(ctx, up, tool, !res.IsError, ms, "")
	return res, nil
}

// addDirectTools registers every tool of one upstream that the token may call as <upstream>__<tool>, instead of the
// four lazy tools (for clients such as Warp that want the tools natively).
func (s *session) addDirectTools(ctx context.Context, srv *mcp.Server, up string) {
	entries, _ := s.d.Mgr.Entries(ctx, func(n string) bool { return n == up })
	sort.Slice(entries, func(i, j int) bool { return entries[i].Tool < entries[j].Tool })
	for _, e := range entries {
		if !s.allow(e) {
			continue
		}
		tool := e.Tool
		srv.AddTool(&mcp.Tool{Name: up + "__" + tool, Description: e.Description, InputSchema: objectSchema(e.Schema)},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				if !acl.Allowed(s.tok.Scopes, up, tool) || !s.d.Mgr.Has(up) {
					s.note(ctx, up, tool, false, 0, "denied, malformed or unknown")
					return fail(notFound), nil
				}
				return s.invoke(ctx, req, up, tool, req.Params.Arguments)
			})
	}
}

// objectSchema returns raw if it is a JSON Schema of type object, else the empty object schema (the SDK refuses
// anything else when a tool is registered).
func objectSchema(raw json.RawMessage) json.RawMessage {
	var m struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &m) != nil || m.Type != "object" {
		return json.RawMessage(`{"type":"object"}`)
	}
	return raw
}

// callRecord is what a handler tells the audit middleware about the call it ran. A call whose handler says nothing
// (the gateway's own tools, malformed arguments, a refused tool name) is recorded with defaults.
type callRecord struct {
	set      bool
	up, tool string
	ok       bool
	ms       int64
	note     string
}

type recordKey struct{}

// note is called by a handler to describe its call. up and tool come from the caller and are clipped on write; note
// must be a fixed short word, never request or error text.
func (s *session) note(ctx context.Context, up, tool string, ok bool, ms int64, note string) {
	if r, _ := ctx.Value(recordKey{}).(*callRecord); r != nil {
		*r = callRecord{true, up, tool, ok, ms, note}
	}
}

// auditing writes exactly one audit row per tools/call and per tools/list: token id, client address, tool, outcome
// and duration. Arguments and results are never stored.
func (s *session) auditing(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method != "tools/call" && method != "tools/list" {
			return next(ctx, method, req)
		}
		rec := &callRecord{}
		start := time.Now()
		res, err := next(context.WithValue(ctx, recordKey{}, rec), method, req)
		if !rec.set {
			rec.up, rec.tool, rec.ok, rec.note = "cammut", method, err == nil, ""
			if p, isCall := req.GetParams().(*mcp.CallToolParamsRaw); isCall && p != nil {
				rec.tool = p.Name
			}
			if r, isTool := res.(*mcp.CallToolResult); isTool && r != nil && r.IsError {
				rec.ok = false
			}
			if err != nil {
				rec.note = "refused"
			}
			rec.ms = time.Since(start).Milliseconds()
		}
		ip := ""
		if x := req.GetExtra(); x != nil && x.Header != nil {
			ip = x.Header.Get("X-Cammut-Client-IP")
		}
		a := store.Audit{TS: s.d.Now(), TokenID: s.tok.ID, Upstream: clip(rec.up, maxField), Tool: clip(rec.tool, maxField), OK: rec.ok, Millis: rec.ms, Note: rec.note, IP: ip}
		if err := s.d.Store.AddAudit(a); err != nil {
			s.d.Log.Error("audit write failed", "err", err)
		}
		return res, err
	}
}

func errKind(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "unavailable"
}

func parseArgs(req *mcp.CallToolRequest, dst any) error {
	raw := req.Params.Arguments
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

func isObject(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal(raw, &m) == nil
}

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func fail(s string) *mcp.CallToolResult {
	r := text(s)
	r.IsError = true
	return r
}

func jsonText(v any) *mcp.CallToolResult {
	b, err := json.Marshal(v)
	if err != nil {
		return fail("internal error")
	}
	return text(string(b))
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}
