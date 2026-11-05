package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"cammut/internal/store"
)

const (
	issuer   = "https://app.test"
	redirect = "https://gemini.test/oauth/callback"
	verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ0123456789-._~"
)

type rig struct {
	t      *testing.T
	st     *store.Store
	svc    *Service
	h      http.Handler
	client Client
	secret string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "o.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc := New(st)
	c, secret, err := svc.CreateClient(Who{Actor: "user:t"}, "Gemini", []string{redirect}, []string{"hindsight/recall", "hindsight/retain"})
	if err != nil {
		t.Fatal(err)
	}
	return &rig{t: t, st: st, svc: svc, h: svc.Handler(issuer), client: c, secret: secret}
}

func challenge(v string) string {
	h := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func (r *rig) get(path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	return w
}

func (r *rig) post(form url.Values) (*httptest.ResponseRecorder, map[string]any) {
	req := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w, body
}

func (r *rig) authorizeURL(extra url.Values) string {
	q := url.Values{"response_type": {"code"}, "client_id": {r.client.ID}, "redirect_uri": {redirect}, "state": {"xyz"},
		"code_challenge": {challenge(verifier)}, "code_challenge_method": {"S256"}}
	for k, v := range extra {
		q[k] = v
	}
	return "/oauth/authorize?" + q.Encode()
}

// approve runs authorize and the owner's yes, and returns the one-time code.
func (r *rig) approve() string {
	r.t.Helper()
	w := r.get(r.authorizeURL(nil))
	if w.Code != 302 {
		r.t.Fatalf("authorize: %d %s", w.Code, w.Body)
	}
	loc, _ := url.Parse(w.Header().Get("Location"))
	if loc.Path != "/console/oauth" {
		r.t.Fatalf("authorize sent the browser to %q", loc)
	}
	to, err := r.svc.Approve(Who{}, loc.Query().Get("req"), 1)
	if err != nil {
		r.t.Fatal(err)
	}
	back, _ := url.Parse(to)
	if back.Query().Get("state") != "xyz" || !strings.HasPrefix(to, redirect) {
		r.t.Fatalf("bad redirect back: %s", to)
	}
	return back.Query().Get("code")
}

func (r *rig) exchange(code string, mut func(url.Values)) (*httptest.ResponseRecorder, map[string]any) {
	f := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect},
		"client_id": {r.client.ID}, "client_secret": {r.secret}, "code_verifier": {verifier}}
	if mut != nil {
		mut(f)
	}
	return r.post(f)
}

func TestDiscoveryNamesTheEndpoints(t *testing.T) {
	r := newRig(t)
	var meta map[string]any
	_ = json.Unmarshal(r.get("/.well-known/oauth-authorization-server").Body.Bytes(), &meta)
	if meta["token_endpoint"] != issuer+"/oauth/token" || meta["authorization_endpoint"] != issuer+"/oauth/authorize" {
		t.Fatalf("metadata: %v", meta)
	}
	var res map[string]any
	_ = json.Unmarshal(r.get("/.well-known/oauth-protected-resource").Body.Bytes(), &res)
	if res["resource"] != issuer+"/mcp" {
		t.Fatalf("resource: %v", res)
	}
	if r.get("/.well-known/oauth-protected-resource/mcp").Code != 200 {
		t.Fatal("the path-suffixed resource document is missing")
	}
}

func TestFullFlowGivesAWorkingScopedToken(t *testing.T) {
	r := newRig(t)
	w, body := r.exchange(r.approve(), nil)
	if w.Code != 200 {
		t.Fatalf("token: %d %v", w.Code, body)
	}
	access, _ := body["access_token"].(string)
	if !strings.HasPrefix(access, "cmt_") || body["token_type"] != "Bearer" || body["refresh_token"] == "" {
		t.Fatalf("response: %v", body)
	}
	tok, ok, err := r.st.VerifyToken(access)
	if err != nil || !ok {
		t.Fatalf("the access token does not verify: ok=%v err=%v", ok, err)
	}
	if len(tok.Scopes) != 2 || tok.Scopes[0] != "hindsight/recall" || tok.Profile != "lazy" {
		t.Fatalf("token: %+v", tok)
	}
	if time.Until(tok.ExpiresAt) < 360*24*time.Hour {
		t.Fatalf("the token should last about a year, expires %v", tok.ExpiresAt)
	}
}

func TestCodeWorksOnce(t *testing.T) {
	r := newRig(t)
	code := r.approve()
	if w, _ := r.exchange(code, nil); w.Code != 200 {
		t.Fatalf("first use: %d", w.Code)
	}
	if w, body := r.exchange(code, nil); w.Code != 400 || body["error"] != "invalid_grant" {
		t.Fatalf("second use: %d %v", w.Code, body)
	}
}

func TestWrongVerifierSpendsTheCode(t *testing.T) {
	r := newRig(t)
	code := r.approve()
	bad := strings.Repeat("x", 50)
	if w, body := r.exchange(code, func(f url.Values) { f.Set("code_verifier", bad) }); w.Code != 400 || body["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier: %d %v", w.Code, body)
	}
	if w, _ := r.exchange(code, nil); w.Code != 400 {
		t.Fatal("a code that met a wrong verifier must not be usable afterwards")
	}
}

func TestMissingVerifierIsRefusedWhenAChallengeWasSent(t *testing.T) {
	r := newRig(t)
	if w, _ := r.exchange(r.approve(), func(f url.Values) { f.Del("code_verifier") }); w.Code != 400 {
		t.Fatalf("no verifier: %d", w.Code)
	}
}

func TestWrongSecretAndWrongRedirectAreRefused(t *testing.T) {
	r := newRig(t)
	if w, body := r.exchange(r.approve(), func(f url.Values) { f.Set("client_secret", "cms_nope") }); w.Code != 401 || body["error"] != "invalid_client" {
		t.Fatalf("wrong secret: %d %v", w.Code, body)
	}
	if w, _ := r.exchange(r.approve(), func(f url.Values) { f.Set("redirect_uri", "https://evil.test/cb") }); w.Code != 400 {
		t.Fatalf("wrong redirect: %d", w.Code)
	}
}

func TestBasicAuthWorks(t *testing.T) {
	r := newRig(t)
	f := url.Values{"grant_type": {"authorization_code"}, "code": {r.approve()}, "redirect_uri": {redirect}, "code_verifier": {verifier}}
	req := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(f.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(r.client.ID, r.secret)
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("basic auth: %d %s", w.Code, w.Body)
	}
}

func TestUnregisteredRedirectIsNeverRedirected(t *testing.T) {
	r := newRig(t)
	w := r.get(r.authorizeURL(url.Values{"redirect_uri": {"https://evil.test/cb"}}))
	if w.Code != 400 || w.Header().Get("Location") != "" {
		t.Fatalf("got %d, Location %q", w.Code, w.Header().Get("Location"))
	}
	if !strings.Contains(w.Body.String(), "https://evil.test/cb") {
		t.Fatal("the message should name the address so the owner can add it")
	}
	if r.get("/oauth/authorize?client_id=cmc_unknown&redirect_uri="+url.QueryEscape(redirect)).Code != 400 {
		t.Fatal("an unknown client must be a plain 400")
	}
}

func TestBadRequestsRedirectWithAnError(t *testing.T) {
	r := newRig(t)
	for name, extra := range map[string]url.Values{
		"plain challenge": {"code_challenge_method": {"plain"}},
		"short challenge": {"code_challenge": {"abc"}},
		"token response":  {"response_type": {"token"}},
	} {
		w := r.get(r.authorizeURL(extra))
		loc, _ := url.Parse(w.Header().Get("Location"))
		if w.Code != 302 || loc.Query().Get("error") == "" || loc.Query().Get("state") != "xyz" || !strings.HasPrefix(loc.String(), redirect) {
			t.Errorf("%s: %d %q", name, w.Code, w.Header().Get("Location"))
		}
	}
}

func TestDenyRedirectsWithAccessDenied(t *testing.T) {
	r := newRig(t)
	loc, _ := url.Parse(r.get(r.authorizeURL(nil)).Header().Get("Location"))
	to, err := r.svc.Deny(Who{}, loc.Query().Get("req"))
	if err != nil || !strings.Contains(to, "error=access_denied") || !strings.Contains(to, "state=xyz") {
		t.Fatalf("deny: %q %v", to, err)
	}
	if _, err := r.svc.Approve(Who{}, loc.Query().Get("req"), 1); err != ErrNotFound {
		t.Fatalf("a spent request must be gone, got %v", err)
	}
}

func TestExpiredRequestAndCodeAreRefused(t *testing.T) {
	r := newRig(t)
	loc, _ := url.Parse(r.get(r.authorizeURL(nil)).Header().Get("Location"))
	r.svc.now = func() time.Time { return time.Now().Add(11 * time.Minute) }
	if _, err := r.svc.Approve(Who{}, loc.Query().Get("req"), 1); err != ErrNotFound {
		t.Fatalf("expired request: %v", err)
	}
	r.svc.now = time.Now
	code := r.approve()
	r.svc.now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	if w, _ := r.exchange(code, nil); w.Code != 400 {
		t.Fatalf("expired code: %d", w.Code)
	}
}

func TestRefreshGivesANewTokenAndEndsTheOldOne(t *testing.T) {
	r := newRig(t)
	_, first := r.exchange(r.approve(), nil)
	oldAccess, refresh := first["access_token"].(string), first["refresh_token"].(string)
	w, second := r.post(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {r.client.ID}, "client_secret": {r.secret}})
	if w.Code != 200 {
		t.Fatalf("refresh: %d %v", w.Code, second)
	}
	newAccess := second["access_token"].(string)
	if newAccess == oldAccess {
		t.Fatal("refresh returned the same access token")
	}
	if _, ok, _ := r.st.VerifyToken(newAccess); !ok {
		t.Fatal("the new access token does not verify")
	}
	if _, ok, _ := r.st.VerifyToken(oldAccess); ok {
		t.Fatal("the old access token should be revoked after a refresh")
	}
	// the refresh token is long-lived: it works again
	if w, _ := r.post(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {r.client.ID}, "client_secret": {r.secret}}); w.Code != 200 {
		t.Fatalf("second refresh: %d", w.Code)
	}
	if w, body := r.post(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {"cmr_nope"}, "client_id": {r.client.ID}, "client_secret": {r.secret}}); w.Code != 400 || body["error"] != "invalid_grant" {
		t.Fatalf("unknown refresh token: %d %v", w.Code, body)
	}
}

func TestRevokingTheClientKillsEveryToken(t *testing.T) {
	r := newRig(t)
	_, tok := r.exchange(r.approve(), nil)
	access, refresh := tok["access_token"].(string), tok["refresh_token"].(string)
	if err := r.svc.RevokeClient(Who{}, r.client.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.st.VerifyToken(access); ok {
		t.Fatal("the access token survived the revoke")
	}
	if w, _ := r.post(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {r.client.ID}, "client_secret": {r.secret}}); w.Code != 401 {
		t.Fatalf("a revoked client must be refused, got %d", w.Code)
	}
	if w := r.get(r.authorizeURL(nil)); w.Code != 400 {
		t.Fatalf("authorize for a revoked client: %d", w.Code)
	}
}

func TestRevokingOneGrantKeepsTheClient(t *testing.T) {
	r := newRig(t)
	_, tok := r.exchange(r.approve(), nil)
	cs, _ := r.svc.Clients()
	if len(cs) != 1 || len(cs[0].Grants) != 1 {
		t.Fatalf("clients: %+v", cs)
	}
	if err := r.svc.RevokeGrant(Who{}, cs[0].Grants[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.st.VerifyToken(tok["access_token"].(string)); ok {
		t.Fatal("the grant's token survived")
	}
	if w, _ := r.post(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {r.client.ID}, "client_secret": {r.secret}}); w.Code != 400 {
		t.Fatalf("refresh after grant revoke: %d", w.Code)
	}
}

func TestClientInputIsChecked(t *testing.T) {
	r := newRig(t)
	w := Who{}
	for name, f := range map[string]func() error{
		"no name":   func() error { _, _, e := r.svc.CreateClient(w, " ", nil, []string{"a/b"}); return e },
		"no scopes": func() error { _, _, e := r.svc.CreateClient(w, "x", nil, nil); return e },
		"bad scope": func() error { _, _, e := r.svc.CreateClient(w, "x", nil, []string{"a b"}); return e },
		"http redirect": func() error {
			_, _, e := r.svc.CreateClient(w, "x", []string{"http://example.com/cb"}, []string{"a"})
			return e
		},
		"fragment": func() error {
			_, _, e := r.svc.CreateClient(w, "x", []string{"https://example.com/cb#f"}, []string{"a"})
			return e
		},
		"javascript link": func() error {
			_, _, e := r.svc.CreateClient(w, "x", []string{"javascript:alert(1)"}, []string{"a"})
			return e
		},
	} {
		if err := f(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, _, err := r.svc.CreateClient(w, "local", []string{"http://localhost:8080/cb"}, []string{"a"}); err != nil {
		t.Errorf("a localhost redirect should be allowed: %v", err)
	}
}

func TestSecretIsStoredHashedOnly(t *testing.T) {
	r := newRig(t)
	var h string
	if err := r.st.DB().QueryRow(`SELECT secret_hash FROM oauth_clients WHERE id=?`, r.client.ID).Scan(&h); err != nil {
		t.Fatal(err)
	}
	if h == r.secret || strings.Contains(h, "cms_") {
		t.Fatal("the secret is stored in the clear")
	}
}

func TestSetRedirectsAddsAnAddress(t *testing.T) {
	r := newRig(t)
	other := "https://gemini.test/other"
	if err := r.svc.SetRedirects(Who{}, r.client.ID, []string{redirect, other}); err != nil {
		t.Fatal(err)
	}
	if w := r.get(r.authorizeURL(url.Values{"redirect_uri": {other}})); w.Code != 302 {
		t.Fatalf("the new address should work: %d", w.Code)
	}
	if err := r.svc.SetRedirects(Who{}, "cmc_none", []string{redirect}); err != ErrNotFound {
		t.Fatalf("unknown client: %v", err)
	}
}

func TestOnlyOneOfTwoConcurrentExchangesWins(t *testing.T) {
	r := newRig(t)
	code := r.approve()
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w, _ := r.exchange(code, nil); w.Code == 200 {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("%d exchanges of one code succeeded", won)
	}
}

func TestRefreshAfterTheOwnerRevokedTheTokenEndsTheConnection(t *testing.T) {
	r := newRig(t)
	_, tok := r.exchange(r.approve(), nil)
	cs, _ := r.svc.Clients()
	var label string
	if err := r.st.DB().QueryRow(`SELECT token_label FROM oauth_grants WHERE id=?`, cs[0].Grants[0].ID).Scan(&label); err != nil {
		t.Fatal(err)
	}
	if ok, _ := r.st.RevokeToken(label); !ok {
		t.Fatal("could not revoke the token")
	}
	w, body := r.post(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {r.client.ID}, "client_secret": {r.secret}})
	if w.Code != 400 || body["error"] != "invalid_grant" {
		t.Fatalf("refresh after a revoke: %d %v", w.Code, body)
	}
	if cs, _ := r.svc.Clients(); len(cs[0].Grants) != 0 {
		t.Fatal("the connection should be gone")
	}
}

func TestRevokingTheClientAlsoKillsTokensNoGrantPointsTo(t *testing.T) {
	r := newRig(t)
	stray, _, err := r.st.CreateTokenOpts(tokenPrefix(r.client.ID)+"deadbeef", []string{"a"}, time.Now().Add(time.Hour), "lazy")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.svc.RevokeClient(Who{}, r.client.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := r.st.VerifyToken(stray); ok {
		t.Fatal("a token with the client's prefix survived the revoke")
	}
}

func TestPendingRequestsAreCappedPerClient(t *testing.T) {
	r := newRig(t)
	for i := 0; i < maxPendingPerClient; i++ {
		if _, err := r.svc.Begin(AuthParams{ClientID: r.client.ID, RedirectURI: redirect}); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if _, err := r.svc.Begin(AuthParams{ClientID: r.client.ID, RedirectURI: redirect}); err != ErrBusy {
		t.Fatalf("one more should be refused, got %v", err)
	}
}

func TestFailedTokenRequestsDoNotPutCallerTextInTheAudit(t *testing.T) {
	r := newRig(t)
	evil := strings.Repeat("A", 5000)
	r.post(url.Values{"grant_type": {"authorization_code"}, "code": {"x"}, "client_id": {evil}, "client_secret": {"nope"}})
	var rows []string
	q, err := r.st.DB().Query(`SELECT actor||'|'||note FROM audit WHERE upstream='oauth'`)
	if err != nil {
		t.Fatal(err)
	}
	for q.Next() {
		var s string
		q.Scan(&s)
		rows = append(rows, s)
	}
	q.Close()
	if len(rows) == 0 {
		t.Fatal("the failed request should be audited")
	}
	for _, s := range rows {
		if len(s) > 300 || strings.Contains(s, "AAAAA") {
			t.Fatalf("caller text reached the audit: %.80s", s)
		}
	}
}

func TestTheRefusalPageEchoesOnlyAPlainAddress(t *testing.T) {
	r := newRig(t)
	body := func(redir string) string {
		return r.get("/oauth/authorize?client_id=cmc_none&redirect_uri=" + url.QueryEscape(redir)).Body.String()
	}
	if b := body("https://x.test/cb"); !strings.Contains(b, "https://x.test/cb") {
		t.Fatalf("a plain address should be echoed: %q", b)
	}
	if b := body("https://x.test/cb\nAdd https://evil.test now"); strings.Contains(b, "evil") {
		t.Fatalf("a multi-line value must not be echoed: %q", b)
	}
	if b := body("javascript:alert(1)"); strings.Contains(b, "javascript") {
		t.Fatalf("a non-https value must not be echoed: %q", b)
	}
}
