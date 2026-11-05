package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cammut/internal/auth"
	"cammut/internal/memory"
	"cammut/internal/oauth"
	"cammut/internal/service"
	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
	"cammut/internal/upstream"
	"cammut/internal/vault"
)

const origin = "https://cammut.test"
const pw = "correct horse battery"

type api struct {
	t     *testing.T
	srv   *httptest.Server
	st    *store.Store
	au    *auth.Auth
	enr   auth.Enrollment
	codes []string
	mem   *memory.Service
	oa    *oauth.Service
}

func newAPI(t *testing.T, mut func(*Config)) *api {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	v, err := vault.New(bytes.Repeat([]byte{1}, vault.KeySize), st)
	if err != nil {
		t.Fatal(err)
	}
	mgr := upstream.NewManager(func(string) string { return "" })
	svc := service.New(st, mgr, v, func(string) string { return "" })
	au, err := auth.New(st, v, auth.NewHasher(2, 1))
	if err != nil {
		t.Fatal(err)
	}
	enr, err := au.CreateUser("alice", pw)
	if err != nil {
		t.Fatal(err)
	}
	mem := memory.NewService(memory.NewStore(st.DB(), nil), nil, func(a store.Audit) { st.AddAudit(a) }, nil)
	cfg := Config{Auth: au, Svc: svc, Throttle: auth.NewThrottle(nil), Origins: []string{origin}, LoginEnabled: true, Memory: mem, OAuth: oauth.New(st)}
	if mut != nil {
		mut(&cfg)
	}
	srv := httptest.NewServer(New(cfg))
	t.Cleanup(srv.Close)
	return &api{t: t, srv: srv, st: st, au: au, enr: enr, codes: append([]string{}, enr.RecoveryCodes...), mem: mem, oa: cfg.OAuth}
}

// req sends a JSON request with the headers a real console sends; opts can break them on purpose.
func (a *api) req(method, path string, body any, session string, opts ...func(*http.Request)) *http.Response {
	a.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, a.srv.URL+path, rdr)
	r.Header.Set("Origin", origin)
	r.Header.Set("X-Requested-With", "cammut")
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if session != "" {
		r.AddCookie(&http.Cookie{Name: "__Host-cammut", Value: session})
	}
	for _, o := range opts {
		o(r)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		a.t.Fatal(err)
	}
	a.t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// login spends one recovery code per call so a test can log in repeatedly within one TOTP step.
func (a *api) login() string {
	a.t.Helper()
	code := a.codes[0]
	a.codes = a.codes[1:]
	resp := a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": code}, "")
	if resp.StatusCode != 200 {
		a.t.Fatalf("login: %d", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == "__Host-cammut" {
			return c.Value
		}
	}
	a.t.Fatal("no session cookie")
	return ""
}

func decode(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

func TestLoginSetsAHardenedCookieAndMeWorks(t *testing.T) {
	a := newAPI(t, nil)
	resp := a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": a.codes[0]}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var c *http.Cookie
	for _, k := range resp.Cookies() {
		if k.Name == "__Host-cammut" {
			c = k
		}
	}
	if c == nil || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Domain != "" || c.MaxAge <= 0 {
		t.Fatalf("cookie: %+v", c)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("API responses must not be cached")
	}
	me := a.req("GET", "/api/v1/me", nil, c.Value)
	var m map[string]any
	decode(t, me, &m)
	if me.StatusCode != 200 || m["username"] != "alice" {
		t.Fatalf("me: %d %v", me.StatusCode, m)
	}
	if a.req("GET", "/api/v1/me", nil, "").StatusCode != 401 || a.req("GET", "/api/v1/me", nil, "bogus").StatusCode != 401 {
		t.Fatal("no or wrong session must be 401")
	}
}

func TestLoginFailuresAreGenericAndThrottled(t *testing.T) {
	a := newAPI(t, nil)
	for i := 0; i < 5; i++ {
		resp := a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": "wrong password here", "code": "000000"}, "")
		var e map[string]string
		decode(t, resp, &e)
		if resp.StatusCode != 401 || e["error"] != "invalid credentials" {
			t.Fatalf("attempt %d: %d %v", i, resp.StatusCode, e)
		}
	}
	resp := a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": a.codes[0]}, "")
	if resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("sixth attempt: %d retry-after=%q", resp.StatusCode, resp.Header.Get("Retry-After"))
	}
}

func TestLoginCanBeSwitchedOffAndStateChangesNeedCSRFHeaders(t *testing.T) {
	off := newAPI(t, func(c *Config) { c.LoginEnabled = false })
	if off.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": off.codes[0]}, "").StatusCode != 404 {
		t.Fatal("a disabled login must look absent")
	}
	var m map[string]bool
	decode(t, off.req("GET", "/api/v1/auth/methods", nil, ""), &m)
	if m["password"] || m["github"] {
		t.Fatalf("methods when disabled: %v", m)
	}

	a := newAPI(t, nil)
	tok := a.login()
	routes := []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": "x"}},
		{"POST", "/api/v1/logout", nil},
		{"POST", "/api/v1/upstreams", map[string]any{"name": "x", "url": "http://127.0.0.1:1/mcp"}},
		{"PATCH", "/api/v1/upstreams/x", map[string]any{}},
		{"DELETE", "/api/v1/upstreams/x", nil},
		{"POST", "/api/v1/upstreams/x/test", nil},
		{"POST", "/api/v1/tokens", map[string]any{"label": "t"}},
		{"PATCH", "/api/v1/tokens/t", map[string]any{"scopes": []string{}}},
		{"DELETE", "/api/v1/tokens/t", nil},
		{"PUT", "/api/v1/secrets/X_Y", sv("v")},
		{"DELETE", "/api/v1/secrets/X_Y", nil},
	}
	breakers := map[string]func(*http.Request){
		"no X-Requested-With": func(r *http.Request) { r.Header.Del("X-Requested-With") },
		"foreign origin":      func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") },
		"absent origin":       func(r *http.Request) { r.Header.Del("Origin") },
		"null origin":         func(r *http.Request) { r.Header.Set("Origin", "null") },
		"form content type":   func(r *http.Request) { r.Header.Set("Content-Type", "application/x-www-form-urlencoded") },
	}
	for _, rt := range routes {
		for name, br := range breakers {
			if name == "form content type" && rt.body == nil {
				continue // no body, no content type to check
			}
			resp := a.req(rt.method, rt.path, rt.body, tok, br)
			if resp.StatusCode != 403 && resp.StatusCode != 415 {
				t.Fatalf("%s %s with %s: got %d, want 403/415", rt.method, rt.path, name, resp.StatusCode)
			}
		}
	}
	if a.req("GET", "/api/v1/me", nil, tok, func(r *http.Request) { r.Header.Del("Origin"); r.Header.Del("X-Requested-With") }).StatusCode != 200 {
		t.Fatal("GET requests are side-effect free and need no CSRF headers")
	}
}

func TestLogoutEndsTheSession(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	if resp := a.req("POST", "/api/v1/logout", nil, tok); resp.StatusCode != 200 {
		t.Fatalf("logout: %d", resp.StatusCode)
	}
	if a.req("GET", "/api/v1/me", nil, tok).StatusCode != 401 {
		t.Fatal("the session must be gone after logout")
	}
}

func TestUpstreamsEndToEnd(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	ts := fakemcp.New(t, "tok123", fakemcp.Tool{Name: "echo", Description: "Echo", Run: func(map[string]any) string { return "x" }})
	if a.req("GET", "/api/v1/upstreams", nil, "").StatusCode != 401 {
		t.Fatal("upstreams need a session")
	}
	resp := a.req("POST", "/api/v1/upstreams", map[string]any{"name": "gh", "url": ts.URL, "bearer_secret": "GH_PAT"}, tok)
	if resp.StatusCode != 201 {
		t.Fatalf("add: %d", resp.StatusCode)
	}
	if a.req("POST", "/api/v1/upstreams", map[string]any{"name": "gh", "url": ts.URL}, tok).StatusCode != 409 {
		t.Fatal("duplicate must be 409")
	}
	if a.req("POST", "/api/v1/upstreams", map[string]any{"name": "Bad Name", "url": ts.URL}, tok).StatusCode != 400 {
		t.Fatal("invalid name must be 400")
	}
	if a.req("POST", "/api/v1/upstreams", map[string]any{"name": "x", "url": ts.URL, "surprise": 1}, tok).StatusCode != 400 {
		t.Fatal("unknown fields must be 400")
	}
	var test service.TestResult
	decode(t, a.req("POST", "/api/v1/upstreams/gh/test", nil, tok), &test)
	if test.OK {
		t.Fatal("the test must fail while the secret is missing")
	}
	if a.req("PUT", "/api/v1/secrets/GH_PAT", sv("tok123"), tok).StatusCode != 204 {
		t.Fatal("put secret")
	}
	decode(t, a.req("POST", "/api/v1/upstreams/gh/test", nil, tok), &test)
	if !test.OK || len(test.Tools) != 1 {
		t.Fatalf("test after the secret: %+v", test)
	}
	var list []service.UpstreamView
	decode(t, a.req("GET", "/api/v1/upstreams", nil, tok), &list)
	if len(list) != 1 || list[0].Name != "gh" || !list[0].SecretSet {
		t.Fatalf("list: %+v", list)
	}
	if a.req("PATCH", "/api/v1/upstreams/gh", map[string]any{"enabled": false}, tok).StatusCode != 204 {
		t.Fatal("patch")
	}
	if a.req("PATCH", "/api/v1/upstreams/ghost", map[string]any{"enabled": false}, tok).StatusCode != 404 {
		t.Fatal("patch of an unknown upstream must be 404")
	}
	if a.req("DELETE", "/api/v1/upstreams/gh", nil, tok).StatusCode != 204 || a.req("DELETE", "/api/v1/upstreams/gh", nil, tok).StatusCode != 404 {
		t.Fatal("delete then delete again must be 204 then 404")
	}
	if a.req("POST", "/api/v1/upstreams/ghost/test", nil, tok).StatusCode != 404 {
		t.Fatal("test of an unknown upstream must be 404")
	}
}

func TestTokensNeverExposePlaintextAfterCreation(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	resp := a.req("POST", "/api/v1/tokens", map[string]any{"label": "warp", "scopes": []string{"github/*"}, "expires_in_hours": 24}, tok)
	var created map[string]any
	decode(t, resp, &created)
	plain, _ := created["token"].(string)
	if resp.StatusCode != 201 || !strings.HasPrefix(plain, "cmt_") || created["expires_at"] == nil {
		t.Fatalf("create: %d %v", resp.StatusCode, created)
	}
	if _, ok, _ := a.st.VerifyToken(plain); !ok {
		t.Fatal("the plaintext shown once must work")
	}
	listResp := a.req("GET", "/api/v1/tokens", nil, tok)
	raw, _ := io.ReadAll(listResp.Body)
	if strings.Contains(string(raw), plain) || strings.Contains(string(raw), "cmt_") || strings.Contains(string(raw), "hash") {
		t.Fatalf("the token list must carry no plaintext or hash: %s", raw)
	}
	var list []map[string]any
	json.Unmarshal(raw, &list)
	if len(list) != 1 || list[0]["label"] != "warp" || list[0]["revoked"] != false {
		t.Fatalf("list: %v", list)
	}
	if id, ok := list[0]["id"].(float64); !ok || id <= 0 {
		t.Fatalf("the token list must carry the numeric id for the audit page: %v", list[0])
	}
	if a.req("POST", "/api/v1/tokens", map[string]any{"label": "warp"}, tok).StatusCode != 409 {
		t.Fatal("duplicate label must be 409")
	}
	if a.req("POST", "/api/v1/tokens", map[string]any{"label": "x", "scopes": []string{"bad scope"}}, tok).StatusCode != 400 {
		t.Fatal("invalid scope must be 400")
	}
	if a.req("POST", "/api/v1/tokens", map[string]any{"label": "x", "profile": "direct:cammut-admin"}, tok).StatusCode != 400 {
		t.Fatal("the API must not mint non-lazy profiles")
	}
	if a.req("PATCH", "/api/v1/tokens/warp", map[string]any{"scopes": []string{"github/*", "hindsight/*"}}, tok).StatusCode != 204 {
		t.Fatal("patch scopes")
	}
	if a.req("PATCH", "/api/v1/tokens/ghost", map[string]any{"scopes": []string{}}, tok).StatusCode != 404 {
		t.Fatal("unknown token must be 404")
	}
	if a.req("DELETE", "/api/v1/tokens/warp", nil, tok).StatusCode != 204 {
		t.Fatal("revoke")
	}
	if _, ok, _ := a.st.VerifyToken(plain); ok {
		t.Fatal("revoked token still works")
	}
	if a.req("DELETE", "/api/v1/tokens/warp", nil, tok).StatusCode != 404 {
		t.Fatal("second revoke must be 404")
	}
}

func TestSecretsAreWriteOnly(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	if a.req("PUT", "/api/v1/secrets/GH_PAT", sv("github_pat_VALUE"), tok).StatusCode != 204 {
		t.Fatal("put")
	}
	resp := a.req("GET", "/api/v1/secrets", nil, tok)
	raw, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(raw), "VALUE") || !strings.Contains(string(raw), "GH_PAT") {
		t.Fatalf("list: %s", raw)
	}
	if a.req("GET", "/api/v1/secrets/GH_PAT", nil, tok).StatusCode != 405 && a.req("GET", "/api/v1/secrets/GH_PAT", nil, tok).StatusCode != 404 {
		t.Fatal("there must be no way to read one secret back")
	}
	for _, bad := range []map[string]any{{"value": ""}, {"value": "has\nnewline"}, {"value": " x"}} {
		if a.req("PUT", "/api/v1/secrets/GH_PAT", bad, tok).StatusCode != 400 {
			t.Fatalf("value %v must be 400", bad)
		}
	}
	if a.req("PUT", "/api/v1/secrets/lower", sv("x"), tok).StatusCode != 400 {
		t.Fatal("invalid name must be 400")
	}
	if a.req("DELETE", "/api/v1/secrets/GH_PAT", nil, tok).StatusCode != 204 || a.req("DELETE", "/api/v1/secrets/GH_PAT", nil, tok).StatusCode != 404 {
		t.Fatal("delete then delete again must be 204 then 404")
	}
}

func TestAuditEndpointFiltersAndShowsAdminActions(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	a.req("PUT", "/api/v1/secrets/GH_PAT", sv("abc"), tok)
	a.req("POST", "/api/v1/tokens", map[string]any{"label": "warp"}, tok)
	var rows []map[string]any
	decode(t, a.req("GET", "/api/v1/audit?upstream=admin&limit=10", nil, tok), &rows)
	// newest first: the token, the secret, and the login that opened this session
	if len(rows) != 3 || rows[0]["actor"] != "user:alice" || rows[0]["tool"] != "token.create" || rows[2]["tool"] != "auth.login" {
		t.Fatalf("rows: %v", rows)
	}
	decode(t, a.req("GET", "/api/v1/audit?tool=secret&ok=true", nil, tok), &rows)
	if len(rows) != 1 || rows[0]["tool"] != "secret.put" {
		t.Fatalf("filtered rows: %v", rows)
	}
	decode(t, a.req("GET", "/api/v1/audit?token=ghost", nil, tok), &rows)
	if len(rows) != 0 {
		t.Fatalf("an unknown token label must give no rows: %v", rows)
	}
	if a.req("GET", "/api/v1/audit?since=notatime", nil, tok).StatusCode != 400 {
		t.Fatal("a bad time must be 400")
	}
	if a.req("GET", "/api/v1/audit", nil, "").StatusCode != 401 {
		t.Fatal("audit needs a session")
	}
}

func TestBodiesAreBoundedAndStrict(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	big := strings.Repeat("a", 1<<20)
	if resp := a.req("PUT", "/api/v1/secrets/GH_PAT", sv(big), tok); resp.StatusCode != 413 {
		t.Fatalf("a 1 MB body: %d", resp.StatusCode)
	}
	for _, raw := range []string{`{"label":"x"} {"label":"y"}`, `{"label":"x"`, `[1,2]`, `{"label":1}`} {
		resp := a.req("POST", "/api/v1/tokens", nil, tok, func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader(raw))
			r.ContentLength = int64(len(raw))
			r.Header.Set("Content-Type", "application/json")
		})
		if resp.StatusCode != 400 {
			t.Fatalf("body %q: got %d, want 400", raw, resp.StatusCode)
		}
	}
	if a.req("GET", "/api/v1/nonexistent", nil, tok).StatusCode != 404 {
		t.Fatal("unknown route must be 404")
	}
}

func TestSessionExpiryReturns401AndClearsTheCookie(t *testing.T) {
	a := newAPI(t, func(c *Config) { c.Auth.Idle = 80 * time.Millisecond }) // set before the server starts: no data race
	tok := a.login()
	time.Sleep(200 * time.Millisecond)
	resp := a.req("GET", "/api/v1/me", nil, tok)
	if resp.StatusCode != 401 {
		t.Fatalf("expired session: %d", resp.StatusCode)
	}
	cleared := false
	for _, c := range resp.Cookies() {
		if c.Name == "__Host-cammut" && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("an expired session should clear the cookie")
	}
}

func TestPrivateListenerUsesAPlainCookieThatSurvivesHTTP(t *testing.T) {
	a := newAPI(t, func(c *Config) { c.Private = true })
	resp := a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": a.codes[0]}, "")
	if resp.StatusCode != 200 {
		t.Fatalf("login: %d", resp.StatusCode)
	}
	var c *http.Cookie
	for _, k := range resp.Cookies() {
		if k.Name == "__Host-cammut" {
			t.Fatal("the __Host- prefix requires Secure, and browsers such as Safari drop a Secure cookie set over plain http (a silent login loop on the SSH-tunnel address)")
		}
		if k.Name == "cammut" {
			c = k
		}
	}
	if c == nil || c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Domain != "" || c.MaxAge <= 0 {
		t.Fatalf("private cookie: %+v", c)
	}
	me, _ := http.NewRequest("GET", a.srv.URL+"/api/v1/me", nil)
	me.AddCookie(&http.Cookie{Name: "cammut", Value: c.Value})
	r, err := http.DefaultClient.Do(me)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("the session must work with the private cookie: %d", r.StatusCode)
	}
	out, _ := http.NewRequest("POST", a.srv.URL+"/api/v1/logout", nil)
	out.Header.Set("Origin", origin)
	out.Header.Set("X-Requested-With", "cammut")
	out.AddCookie(&http.Cookie{Name: "cammut", Value: c.Value})
	lr, err := http.DefaultClient.Do(out)
	if err != nil {
		t.Fatal(err)
	}
	lr.Body.Close()
	cleared := false
	for _, k := range lr.Cookies() {
		if k.Name == "cammut" && k.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("logout must clear the private cookie under its own name")
	}
	if a.req("GET", "/api/v1/me", nil, "").StatusCode != 401 {
		t.Fatal("no cookie, no session")
	}
}

func TestSignInsAndOutsAreAuditedWithoutAnythingTyped(t *testing.T) {
	a := newAPI(t, nil)
	a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": "wrong password here", "code": "000000"}, "")
	first := a.login()
	a.req("POST", "/api/v1/logout", nil, first)
	tok := a.login()
	var rows []map[string]any
	raw, _ := io.ReadAll(a.req("GET", "/api/v1/audit?upstream=admin&limit=50", nil, tok).Body)
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, r := range rows {
		tool, _ := r["tool"].(string)
		if strings.HasPrefix(tool, "auth.") {
			counts[tool]++
			if r["ip"] != "127.0.0.1" {
				t.Fatalf("%s must carry the client address: %v", tool, r)
			}
		}
	}
	if counts["auth.fail"] != 1 || counts["auth.login"] != 2 || counts["auth.logout"] != 1 {
		t.Fatalf("auth rows: %v", counts)
	}
	if s := string(raw); strings.Contains(s, "wrong password here") || strings.Contains(s, "000000") {
		t.Fatalf("what was typed must never reach the audit log: %s", s)
	}
	for _, r := range rows {
		if r["tool"] == "auth.login" && r["actor"] != "user:alice" {
			t.Fatalf("a login row names who signed in: %v", r)
		}
	}
}

func TestThrottledAttemptsAreNotAudited(t *testing.T) {
	a := newAPI(t, nil)
	for i := 0; i < 8; i++ { // five count, the rest are refused before any work and must not write rows
		a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": "wrong password here", "code": "000000"}, "")
	}
	rows, err := a.st.QueryAudit(store.AuditFilter{Upstream: "admin", Tool: "auth.fail"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 {
		t.Fatalf("%d auth.fail rows; a flood of throttled requests must not become a flood of audit rows", len(rows))
	}
}

func TestMemoryConsoleEndpoints(t *testing.T) {
	a := newAPI(t, nil)
	for _, p := range []string{"/api/v1/memory/projects", "/api/v1/memory/notes", "/api/v1/memory/brief/P", "/api/v1/memory/status"} {
		if resp := a.req("GET", p, nil, ""); resp.StatusCode != 401 {
			t.Fatalf("%s without a session: %d", p, resp.StatusCode)
		}
	}
	s := a.login()
	resp := a.req("GET", "/api/v1/memory/projects", nil, s)
	var projects []map[string]any
	decode(t, resp, &projects)
	if resp.StatusCode != 200 || projects == nil || len(projects) != 0 {
		t.Fatalf("an empty store lists [] (%d %v)", resp.StatusCode, projects)
	}
	// agents create notes; the console only reads and retracts
	agent := memory.Actor{Agent: "mcp:test", SkipAudit: true}
	d, err := a.mem.Remember(context.Background(), agent, memory.Note{Project: "P", Kind: "decision", Title: "Use FTS5", Body: "it ships in the driver"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.mem.Remember(context.Background(), agent, memory.Note{Project: "P", Kind: "finding", Title: "TEI is heavy", Body: "851 MiB"}); err != nil {
		t.Fatal(err)
	}
	var notes []map[string]any
	decode(t, a.req("GET", "/api/v1/memory/notes?project=P", nil, s), &notes)
	if len(notes) != 2 || notes[0]["body"] == nil || notes[0]["source_agent"] != "mcp:test" {
		t.Fatalf("notes: %v", notes)
	}
	decode(t, a.req("GET", "/api/v1/memory/notes?project=P&kind=decision&q=fts5", nil, s), &notes)
	if len(notes) != 1 || notes[0]["title"] != "Use FTS5" {
		t.Fatalf("filtered notes: %v", notes)
	}
	if resp := a.req("GET", "/api/v1/memory/notes?kind=gossip", nil, s); resp.StatusCode != 400 {
		t.Fatalf("bad kind: %d", resp.StatusCode)
	}
	var brief map[string]any
	resp = a.req("GET", "/api/v1/memory/brief/P", nil, s)
	decode(t, resp, &brief)
	if resp.StatusCode != 200 || brief["version"].(float64) != 1 || !strings.Contains(brief["body"].(string), "Use FTS5") || brief["accounting"].(map[string]any)["active"].(float64) != 2 {
		t.Fatalf("brief: %d %v", resp.StatusCode, brief)
	}
	if resp := a.req("GET", "/api/v1/memory/brief/P?tier=full", nil, s); resp.StatusCode != 200 {
		t.Fatalf("full tier: %d", resp.StatusCode)
	}
	if resp := a.req("GET", "/api/v1/memory/brief/Nope", nil, s); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %d", resp.StatusCode)
	}
	var st map[string]any
	decode(t, a.req("GET", "/api/v1/memory/status?project=P", nil, s), &st)
	if st["notes"].(float64) != 2 || st["projects"].(float64) != 1 || st["delivery"] != nil {
		t.Fatalf("a person reading the brief is not a delivery to an agent: %v", st)
	}
	// retract: CSRF headers are required, only "retracted" is accepted, the audit row names the person
	path := "/api/v1/memory/notes/" + d.ID
	if resp := a.req("PATCH", path, map[string]string{"status": "retracted"}, s, func(r *http.Request) { r.Header.Del("X-Requested-With") }); resp.StatusCode != 403 {
		t.Fatalf("no CSRF header: %d", resp.StatusCode)
	}
	if resp := a.req("PATCH", path, map[string]string{"status": "active"}, s); resp.StatusCode != 400 {
		t.Fatalf("only retraction is offered: %d", resp.StatusCode)
	}
	if resp := a.req("PATCH", "/api/v1/memory/notes/NOPE", map[string]string{"status": "retracted"}, s); resp.StatusCode != 404 {
		t.Fatalf("unknown note: %d", resp.StatusCode)
	}
	if resp := a.req("PATCH", path, map[string]string{"status": "retracted"}, s); resp.StatusCode != 204 {
		t.Fatalf("retract: %d", resp.StatusCode)
	}
	decode(t, a.req("GET", "/api/v1/memory/notes?project=P", nil, s), &notes)
	if len(notes) != 1 {
		t.Fatalf("a retracted note leaves the default list: %v", notes)
	}
	decode(t, a.req("GET", "/api/v1/memory/notes?project=P&status=any", nil, s), &notes)
	retracted := 0
	for _, n := range notes {
		if n["status"] == "retracted" {
			retracted++
		}
	}
	if len(notes) != 2 || retracted != 1 {
		t.Fatalf("status=any shows the retracted one: %v", notes)
	}
	decode(t, a.req("GET", "/api/v1/memory/brief/P", nil, s), &brief)
	if brief["version"].(float64) != 2 || strings.Contains(brief["body"].(string), "Use FTS5") {
		t.Fatalf("the next brief drops it: %v", brief)
	}
	yes := true
	rows, _ := a.st.QueryAudit(store.AuditFilter{Upstream: "memory", Tool: "retract", OK: &yes})
	if len(rows) != 1 || rows[0].Actor != "user:alice" || rows[0].Note != "P" {
		t.Fatalf("audit: %+v", rows)
	}
}

func TestArchiveAlertsAreMountedOnlyWhenConfigured(t *testing.T) {
	a := newAPI(t, nil)
	if resp := a.req("GET", "/api/v1/archive/alerts", nil, a.login()); resp.StatusCode != 404 {
		t.Fatalf("not configured: %d", resp.StatusCode)
	}
	b := newAPI(t, func(c *Config) {
		c.ArchiveAlerts = func() (ArchiveAlerts, error) {
			return ArchiveAlerts{Segments: 12, RecipientChanges: 1, ReplicaStale: true, Unreplicated: 3}, nil
		}
	})
	if resp := b.req("GET", "/api/v1/archive/alerts", nil, ""); resp.StatusCode != 401 {
		t.Fatalf("needs a session: %d", resp.StatusCode)
	}
	var got map[string]any
	resp := b.req("GET", "/api/v1/archive/alerts", nil, b.login())
	decode(t, resp, &got)
	if resp.StatusCode != 200 || got["recipient_changes"].(float64) != 1 || got["replica_stale"] != true || got["segments"].(float64) != 12 || got["replica_last_run_at"] != nil {
		t.Fatalf("%d %v", resp.StatusCode, got)
	}
}

func TestMeReportsTheConfiguredSiteOriginOnlyToASignedInUser(t *testing.T) {
	a := newAPI(t, func(c *Config) { c.SiteOrigin = "https://cammut.test" })
	tok := a.login()
	var m map[string]any
	decode(t, a.req("GET", "/api/v1/me", nil, tok), &m)
	if m["site_origin"] != "https://cammut.test" {
		t.Fatalf("me: %v", m)
	}
	if resp := a.req("GET", "/api/v1/me", nil, ""); resp.StatusCode != 401 {
		t.Fatalf("anonymous me: %d", resp.StatusCode)
	}
	unset := newAPI(t, nil)
	decode(t, unset.req("GET", "/api/v1/me", nil, unset.login()), &m)
	if v, ok := m["site_origin"]; !ok || v != "" {
		t.Fatalf("an unset origin must be an empty string, got %v", m)
	}
}

// A bearer token (the MCP credential, which may be reachable from the internet) is not a console credential: only a
// cookie session made by the password-and-TOTP login administers tokens, upstreams, secrets and users.
func TestAMCPBearerTokenIsNotAConsoleCredential(t *testing.T) {
	a := newAPI(t, nil)
	plain, _, err := a.st.CreateToken("cloud", []string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	bearer := func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+plain) }
	for _, c := range [][2]string{
		{"GET", "/api/v1/tokens"}, {"POST", "/api/v1/tokens"}, {"GET", "/api/v1/upstreams"}, {"GET", "/api/v1/secrets"}, {"GET", "/api/v1/users"}, {"GET", "/api/v1/me"},
	} {
		if resp := a.req(c[0], c[1], nil, "", bearer); resp.StatusCode != 401 && resp.StatusCode != 404 && resp.StatusCode != 405 {
			t.Errorf("%s %s with a bearer token: %d", c[0], c[1], resp.StatusCode)
		}
	}
	if resp := a.req("GET", "/api/v1/tokens", nil, "", bearer); resp.StatusCode != 401 {
		t.Fatalf("token list with a bearer token: %d", resp.StatusCode)
	}
}

func TestMemoryConsoleShowsKeyHistory(t *testing.T) {
	a := newAPI(t, nil)
	s := a.login()
	agent := memory.Actor{Agent: "mcp:test", SkipAudit: true}
	for _, v := range []string{"0.2.0", "0.3.0"} {
		if _, err := a.mem.Remember(context.Background(), agent, memory.Note{Project: "P", Kind: "state", Key: "cammut.deployed", Title: "Cammut deployed", Body: "version " + v}); err != nil {
			t.Fatal(err)
		}
	}
	if resp := a.req("GET", "/api/v1/memory/history?project=P&key=cammut.deployed", nil, ""); resp.StatusCode != 401 {
		t.Fatalf("needs a session: %d", resp.StatusCode)
	}
	var h []map[string]any
	decode(t, a.req("GET", "/api/v1/memory/history?project=P&key=cammut.deployed", nil, s), &h)
	if len(h) != 2 || h[0]["status"] != "active" || h[0]["key"] != "cammut.deployed" || h[1]["status"] != "superseded" {
		t.Fatalf("history: %v", h)
	}
	if resp := a.req("GET", "/api/v1/memory/history?project=P&key=none", nil, s); resp.StatusCode != 404 {
		t.Fatalf("unknown key: %d", resp.StatusCode)
	}
}

func TestConsoleNotesAreObservedAndAPersonConfirmsAgentGuesses(t *testing.T) {
	a := newAPI(t, nil)
	s := a.login()
	agent := memory.Actor{Agent: "mcp:test", SkipAudit: true}
	sp, err := a.mem.Remember(context.Background(), agent, memory.Note{Project: "P", Kind: "finding", Title: "Hiring plan", Body: "guess: three engineers", Epistemic: memory.Speculative})
	if err != nil {
		t.Fatal(err)
	}
	var made map[string]any
	resp := a.req("POST", "/api/v1/memory/notes", map[string]any{"project": "P", "kind": "preference", "key": "pref.work-style", "title": "Work style", "body": "short answers"}, s)
	decode(t, resp, &made)
	if resp.StatusCode != 201 || made["epistemic"] != "observed" || made["key"] != "pref.work-style" {
		t.Fatalf("console note: %d %v", resp.StatusCode, made)
	}
	if resp := a.req("POST", "/api/v1/memory/notes", map[string]any{"project": "P", "kind": "preference", "title": "x", "body": "y"}, s, func(r *http.Request) { r.Header.Del("X-Requested-With") }); resp.StatusCode != 403 {
		t.Fatalf("CSRF header required: %d", resp.StatusCode)
	}
	var c map[string]any
	resp = a.req("POST", "/api/v1/memory/notes/"+sp.ID+"/confirm", map[string]string{"epistemic": "observed"}, s)
	decode(t, resp, &c)
	if resp.StatusCode != 200 || c["epistemic"] != "observed" {
		t.Fatalf("confirm: %d %v", resp.StatusCode, c)
	}
	if resp := a.req("POST", "/api/v1/memory/notes/NOPE/confirm", map[string]string{"epistemic": "observed"}, s); resp.StatusCode != 404 {
		t.Fatalf("unknown: %d", resp.StatusCode)
	}
	var notes []map[string]any
	decode(t, a.req("GET", "/api/v1/memory/notes?project=P", nil, s), &notes)
	for _, n := range notes {
		if n["epistemic"] == nil {
			t.Fatalf("notes carry their epistemic status: %v", n)
		}
	}
}

type pairEmb map[string][]float32

func (pairEmb) Model() string { return "fake" }
func (e pairEmb) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v, ok := e[t]
		if !ok {
			v = []float32{0, 0, 1}
		}
		out[i] = v
	}
	return out, nil
}

func TestConsoleReviewListAppliesOrDismissesSupersessionSuggestions(t *testing.T) {
	a := newAPI(t, nil)
	s := a.login()
	ms := memory.NewStore(a.st.DB(), nil)
	svc := memory.NewService(ms, memory.NewRanker(ms, pairEmb{"Host\nalpha": {1, 0, 0}, "Host\nbeta": {0.88, 0.475, 0}}, nil), nil, nil)
	agent := memory.Actor{Agent: "mcp:test", SkipAudit: true}
	old, err := svc.Remember(context.Background(), agent, memory.Note{Project: "P", Kind: "state", Title: "Host", Body: "alpha"})
	if err != nil {
		t.Fatal(err)
	}
	svc.Wait()
	if _, err := svc.RememberFull(context.Background(), agent, memory.Note{Project: "P", Kind: "state", Title: "Host", Body: "beta"}, memory.RememberOpts{}); err != nil {
		t.Fatal(err)
	}
	if resp := a.req("GET", "/api/v1/memory/review", nil, ""); resp.StatusCode != 401 {
		t.Fatalf("needs a session: %d", resp.StatusCode)
	}
	var items []map[string]any
	decode(t, a.req("GET", "/api/v1/memory/review?project=P", nil, s), &items)
	if len(items) != 1 || items[0]["candidate"].(map[string]any)["id"] != old.ID || items[0]["note"].(map[string]any)["body"] != "beta" || items[0]["cosine"].(float64) < 0.85 {
		t.Fatalf("review list: %v", items)
	}
	id := int(items[0]["id"].(float64))
	path := fmt.Sprintf("/api/v1/memory/review/%d/apply", id)
	if resp := a.req("POST", path, nil, s, func(r *http.Request) { r.Header.Del("X-Requested-With") }); resp.StatusCode != 403 {
		t.Fatalf("CSRF header: %d", resp.StatusCode)
	}
	if resp := a.req("POST", path, nil, s); resp.StatusCode != 204 {
		t.Fatalf("apply: %d", resp.StatusCode)
	}
	if n, _, _ := ms.GetNote(old.ID); n.Status != "superseded" {
		t.Fatalf("applied: %+v", n)
	}
	decode(t, a.req("GET", "/api/v1/memory/review?project=P", nil, s), &items)
	if len(items) != 0 {
		t.Fatalf("resolved: %v", items)
	}
	if resp := a.req("POST", path, nil, s); resp.StatusCode != 404 {
		t.Fatalf("twice: %d", resp.StatusCode)
	}
	if resp := a.req("POST", "/api/v1/memory/review/99/dismiss", nil, s); resp.StatusCode != 404 {
		t.Fatalf("unknown: %d", resp.StatusCode)
	}
}

// sv is a secret PUT body that carries the mandatory policy for a loopback MCP upstream.
func sv(value string) map[string]any {
	return map[string]any{"value": value, "purpose": "mcp-upstream-bearer", "hosts": []string{"127.0.0.1"}}
}

func TestSecretPolicyRouteNeedsTheTypedNameAndHidesValues(t *testing.T) {
	a := newAPI(t, nil)
	tok := a.login()
	if a.req("PUT", "/api/v1/secrets/KEY_ONE", map[string]any{"value": "v"}, tok).StatusCode != 400 {
		t.Fatal("a new secret without a policy must be 400")
	}
	if a.req("PUT", "/api/v1/secrets/KEY_ONE", sv("secretvalue"), tok).StatusCode != 204 {
		t.Fatal("put")
	}
	body := map[string]any{"purpose": "llm-provider-key", "hosts": []string{"api.example.com"}, "confirm": "nope"}
	if a.req("PUT", "/api/v1/secrets/KEY_ONE/policy", body, tok).StatusCode != 400 {
		t.Fatal("wrong confirmation must be 400")
	}
	body["confirm"] = "KEY_ONE"
	if a.req("PUT", "/api/v1/secrets/KEY_ONE/policy", body, tok).StatusCode != 204 {
		t.Fatal("policy change")
	}
	resp := a.req("GET", "/api/v1/secrets", nil, tok)
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "api.example.com") || !strings.Contains(string(raw), "llm-provider-key") || strings.Contains(string(raw), "secretvalue") {
		t.Fatalf("list: %s", raw)
	}
}
