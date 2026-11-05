package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"cammut/internal/auth"
)

type ghServer struct {
	srv       *httptest.Server
	challenge string
}

func newGH(t *testing.T) *ghServer {
	t.Helper()
	g := &ghServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.PostForm.Get("code") != "good-code" {
			json.NewEncoder(w).Encode(map[string]string{"error": "bad_verification_code"})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": "gho_x"})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"id": 4242})
	})
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	return g
}

func (g *ghServer) cfg() *auth.GitHub {
	return &auth.GitHub{ClientID: "cid", ClientSecret: "sec", RedirectURL: origin + "/auth/github/callback",
		AuthorizeURL: g.srv.URL + "/authorize", TokenURL: g.srv.URL + "/token", APIURL: g.srv.URL}
}

var noFollow = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (a *api) raw(method, path string, cookies ...*http.Cookie) *http.Response {
	a.t.Helper()
	r, _ := http.NewRequest(method, a.srv.URL+path, nil)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	resp, err := noFollow.Do(r)
	if err != nil {
		a.t.Fatal(err)
	}
	a.t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func cookieNamed(resp *http.Response, name string) *http.Cookie {
	for _, c := range resp.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func newGHAPI(t *testing.T) (*api, *ghServer) {
	g := newGH(t)
	a := newAPI(t, func(c *Config) { c.GitHub = func() *auth.GitHub { return g.cfg() } })
	if err := a.au.LinkGitHub("alice", 4242); err != nil {
		t.Fatal(err)
	}
	return a, g
}

func directAPI(t *testing.T) *api {
	g := newGH(t)
	return newAPI(t, func(c *Config) {
		c.GitHub = func() *auth.GitHub {
			cfg := g.cfg()
			cfg.Direct = true
			return cfg
		}
	})
}

func TestGitHubDirectCallbackSignsInAtOnce(t *testing.T) {
	a := directAPI(t)
	if err := a.au.LinkGitHub("alice", 4242); err != nil {
		t.Fatal(err)
	}
	start := a.raw("GET", "/auth/github/start")
	oauth := cookieNamed(start, "__Host-cammut-oauth")
	cb := a.raw("GET", "/auth/github/callback?state="+url.QueryEscape(oauth.Value)+"&code=good-code", oauth)
	if cb.StatusCode != 302 || cb.Header.Get("Location") != "/console/login?github=done" {
		t.Fatalf("callback: %d %q", cb.StatusCode, cb.Header.Get("Location"))
	}
	sess := cookieNamed(cb, "__Host-cammut")
	if sess == nil || !sess.Secure || !sess.HttpOnly || sess.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie: %+v", sess)
	}
	if cookieNamed(cb, "__Host-cammut-pending") != nil {
		t.Fatal("a direct sign-in has no pending step")
	}
	if me := a.req("GET", "/api/v1/me", nil, sess.Value); me.StatusCode != 200 {
		t.Fatalf("the new session does not work: %d", me.StatusCode)
	}
}

func TestGitHubDirectCallbackRefusesAStranger(t *testing.T) {
	a := directAPI(t) // nobody is linked to GitHub id 4242
	start := a.raw("GET", "/auth/github/start")
	oauth := cookieNamed(start, "__Host-cammut-oauth")
	cb := a.raw("GET", "/auth/github/callback?state="+url.QueryEscape(oauth.Value)+"&code=good-code", oauth)
	if cb.StatusCode != 302 || cb.Header.Get("Location") != "/console/login?error=github" || cookieNamed(cb, "__Host-cammut") != nil {
		t.Fatalf("callback: %d %q", cb.StatusCode, cb.Header.Get("Location"))
	}
}

func TestGitHubStartSetsALaxTransactionCookieAndRedirects(t *testing.T) {
	a, g := newGHAPI(t)
	resp := a.raw("GET", "/auth/github/start")
	if resp.StatusCode != 302 || !strings.HasPrefix(resp.Header.Get("Location"), g.srv.URL+"/authorize?") {
		t.Fatalf("start: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	c := cookieNamed(resp, "__Host-cammut-oauth")
	if c == nil || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.Domain != "" || c.MaxAge <= 0 || c.MaxAge > 600 {
		t.Fatalf("oauth cookie: %+v", c)
	}
	u, _ := url.Parse(resp.Header.Get("Location"))
	if u.Query().Get("state") != c.Value {
		t.Fatal("the cookie must carry the same state as the authorize URL")
	}
}

func TestGitHubFullFlowEndsInASessionOnlyWithTheCode(t *testing.T) {
	a, _ := newGHAPI(t)
	start := a.raw("GET", "/auth/github/start")
	oauth := cookieNamed(start, "__Host-cammut-oauth")
	cb := a.raw("GET", "/auth/github/callback?state="+url.QueryEscape(oauth.Value)+"&code=good-code", oauth)
	if cb.StatusCode != 302 || cb.Header.Get("Location") != "/console/login?github=1" {
		t.Fatalf("callback: %d %q", cb.StatusCode, cb.Header.Get("Location"))
	}
	if cleared := cookieNamed(cb, "__Host-cammut-oauth"); cleared == nil || cleared.MaxAge >= 0 {
		t.Fatal("the transaction cookie must be cleared")
	}
	pending := cookieNamed(cb, "__Host-cammut-pending")
	if pending == nil || !pending.Secure || !pending.HttpOnly || pending.SameSite != http.SameSiteStrictMode || pending.MaxAge <= 0 || pending.MaxAge > 300 {
		t.Fatalf("pending cookie: %+v", pending)
	}
	if cookieNamed(cb, "__Host-cammut") != nil {
		t.Fatal("the callback must not create a session")
	}
	if a.req("GET", "/api/v1/me", nil, pending.Value).StatusCode != 401 {
		t.Fatal("the pending token is not a session")
	}

	withPending := func(r *http.Request) { r.AddCookie(pending) }
	if a.req("POST", "/api/v1/login/github", map[string]string{"code": "000000"}, "", withPending).StatusCode != 401 {
		t.Fatal("a wrong code must be 401")
	}
	if a.req("POST", "/api/v1/login/github", map[string]string{"code": a.codes[0]}, "").StatusCode != 401 {
		t.Fatal("no pending cookie must be 401")
	}
	if a.req("POST", "/api/v1/login/github", map[string]string{"code": a.codes[0]}, "", withPending, func(r *http.Request) { r.Header.Del("Origin") }).StatusCode != 403 {
		t.Fatal("the completion step needs the CSRF headers")
	}
	resp := a.req("POST", "/api/v1/login/github", map[string]string{"code": a.codes[0]}, "", withPending)
	if resp.StatusCode != 200 {
		t.Fatalf("complete: %d", resp.StatusCode)
	}
	sess := cookieNamed(resp, "__Host-cammut")
	if sess == nil || sess.SameSite != http.SameSiteStrictMode || !sess.HttpOnly || !sess.Secure {
		t.Fatalf("session cookie: %+v", sess)
	}
	if a.req("GET", "/api/v1/me", nil, sess.Value).StatusCode != 200 {
		t.Fatal("the new session must work")
	}
}

func TestGitHubCallbackFailuresRevealNothing(t *testing.T) {
	a, _ := newGHAPI(t)
	start := a.raw("GET", "/auth/github/start")
	oauth := cookieNamed(start, "__Host-cammut-oauth")
	cases := map[string]*http.Response{
		"no cookie":        a.raw("GET", "/auth/github/callback?state="+url.QueryEscape(oauth.Value)+"&code=good-code"),
		"wrong state":      a.raw("GET", "/auth/github/callback?state=other&code=good-code", oauth),
		"github error":     a.raw("GET", "/auth/github/callback?error=access_denied&state="+url.QueryEscape(oauth.Value), oauth),
		"no parameters":    a.raw("GET", "/auth/github/callback", oauth),
		"unsolicited call": a.raw("GET", "/auth/github/callback?state=x&code=y"),
	}
	for name, resp := range cases {
		if resp.StatusCode != 302 || resp.Header.Get("Location") != "/console/login?error=github" || cookieNamed(resp, "__Host-cammut-pending") != nil {
			t.Fatalf("%s: %d %q", name, resp.StatusCode, resp.Header.Get("Location"))
		}
	}
}

func TestGitHubIsAbsentWhenNotConfiguredOrLoginIsOff(t *testing.T) {
	plain := newAPI(t, nil)
	if plain.raw("GET", "/auth/github/start").StatusCode != 404 {
		t.Fatal("unconfigured GitHub login must look absent")
	}
	var m map[string]bool
	decode(t, plain.req("GET", "/api/v1/auth/methods", nil, ""), &m)
	if !m["password"] || m["github"] {
		t.Fatalf("methods: %v", m)
	}
	g := newGH(t)
	off := newAPI(t, func(c *Config) { c.LoginEnabled = false; c.GitHub = func() *auth.GitHub { return g.cfg() } })
	if off.raw("GET", "/auth/github/start").StatusCode != 404 {
		t.Fatal("with login off GitHub login must look absent too")
	}
	on, _ := newGHAPI(t)
	decode(t, on.req("GET", "/api/v1/auth/methods", nil, ""), &m)
	if !m["github"] {
		t.Fatalf("methods when configured: %v", m)
	}
}

// ---- GitHub-only public mode: the password form is off, GitHub sign-in is on ----

func githubOnlyAPI(t *testing.T) (*api, *ghServer) {
	g := newGH(t)
	a := newAPI(t, func(c *Config) {
		c.GitHubOnly = true
		c.GitHub = func() *auth.GitHub { return g.cfg() }
	})
	if err := a.au.LinkGitHub("alice", 4242); err != nil {
		t.Fatal(err)
	}
	return a, g
}

func TestGitHubOnlyRefusesThePasswordAndReportsIt(t *testing.T) {
	a, _ := githubOnlyAPI(t)
	if a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": a.codes[0]}, "").StatusCode != 404 {
		t.Fatal("with GitHub-only the password login must look absent, even with the right password and code")
	}
	var m map[string]bool
	decode(t, a.req("GET", "/api/v1/auth/methods", nil, ""), &m)
	if m["password"] || !m["github"] {
		t.Fatalf("methods in GitHub-only mode: %v", m)
	}
}

func TestGitHubOnlyStillEndsInASessionOnlyWithTheCode(t *testing.T) {
	a, _ := githubOnlyAPI(t)
	start := a.raw("GET", "/auth/github/start")
	if start.StatusCode != 302 {
		t.Fatalf("start must work in GitHub-only mode: %d", start.StatusCode)
	}
	oauthCookie := cookieNamed(start, "__Host-cammut-oauth")
	cb := a.raw("GET", "/auth/github/callback?state="+url.QueryEscape(oauthCookie.Value)+"&code=good-code", oauthCookie)
	if cb.StatusCode != 302 || cookieNamed(cb, "__Host-cammut") != nil {
		t.Fatalf("GitHub alone must not mint a session in the non-direct mode: %d %q", cb.StatusCode, cb.Header.Get("Location"))
	}
	pending := cookieNamed(cb, "__Host-cammut-pending")
	if pending == nil {
		t.Fatal("expected the pending step that asks for the authenticator code")
	}
	// the code finishes the sign-in
	withPending := func(r *http.Request) { r.AddCookie(pending) }
	done := a.req("POST", "/api/v1/login/github", map[string]string{"code": a.codes[0]}, "", withPending)
	if done.StatusCode != 200 {
		t.Fatalf("finishing with the code: %d", done.StatusCode)
	}
	if cookieNamed(done, "__Host-cammut") == nil {
		t.Fatal("the completed sign-in must set the session cookie")
	}
}

func TestPasswordLoginKeepsWorkingWhenGitHubOnlyIsOff(t *testing.T) {
	a := newAPI(t, nil)
	if a.req("POST", "/api/v1/login", map[string]string{"username": "alice", "password": pw, "code": a.codes[0]}, "").StatusCode != 200 {
		t.Fatal("the default configuration must keep the password login")
	}
}
