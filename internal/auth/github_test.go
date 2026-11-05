package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

const redirect = "https://cammut.test/auth/github/callback"

type fakeGH struct {
	srv       *httptest.Server
	id        int64
	challenge string // the S256 challenge from the authorize URL; the token endpoint must see its verifier
	exchanges int
}

func newFakeGH(t *testing.T, id int64) *fakeGH {
	t.Helper()
	f := &fakeGH{id: id}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		f.exchanges++
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		ok := r.PostForm.Get("client_id") == "cid" && r.PostForm.Get("client_secret") == "sec" &&
			r.PostForm.Get("code") == "good-code" && r.PostForm.Get("redirect_uri") == redirect &&
			base64.RawURLEncoding.EncodeToString(sum[:]) == f.challenge
		if !ok {
			json.NewEncoder(w).Encode(map[string]string{"error": "bad_verification_code"})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": "gho_x"})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_x" {
			http.Error(w, "no", 401)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": f.id, "login": "whatever-they-renamed-to"})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGH) config() *GitHub {
	return &GitHub{ClientID: "cid", ClientSecret: "sec", RedirectURL: redirect,
		AuthorizeURL: f.srv.URL + "/authorize", TokenURL: f.srv.URL + "/login/oauth/access_token", APIURL: f.srv.URL}
}

func start(t *testing.T, e *env, f *fakeGH) (state string) {
	t.Helper()
	u, state, err := e.a.GitHubStart(f.config())
	if err != nil {
		t.Fatal(err)
	}
	pu, _ := url.Parse(u)
	q := pu.Query()
	if q.Get("client_id") != "cid" || q.Get("redirect_uri") != redirect || q.Get("scope") != "read:user" ||
		q.Get("state") != state || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		t.Fatalf("authorize URL parameters: %v", q)
	}
	f.challenge = q.Get("code_challenge")
	return state
}

func TestGitHubLoginNeedsTheAuthenticatorCodeToo(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 4242)
	if err := e.a.LinkGitHub("alice", 4242); err != nil {
		t.Fatal(err)
	}
	th := NewThrottle(func() time.Time { return e.clock })
	state := start(t, e, f)
	pending, err := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code")
	if err != nil || pending == "" {
		t.Fatalf("finish: %q %v", pending, err)
	}
	if _, ok := e.a.Session(pending); ok {
		t.Fatal("the pending token must not be a session")
	}
	if _, err := e.a.GitHubComplete(th, "9.9.9.9", "ua", pending, "000000"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a wrong code must fail: %v", err)
	}
	tok, err := e.a.GitHubComplete(th, "9.9.9.9", "ua", pending, e.code())
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if u, ok := e.a.Session(tok); !ok || u.Username != "alice" {
		t.Fatalf("session: %+v %v", u, ok)
	}
	if _, err := e.a.GitHubComplete(th, "9.9.9.9", "ua", pending, e.enr.RecoveryCodes[0]); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a pending login works once: %v", err)
	}
}

func TestGitHubStateIsBoundSingleUseAndExpires(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 4242)
	e.a.LinkGitHub("alice", 4242)

	state := start(t, e, f)
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), state, "other-browser-cookie", "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a state that does not match the browser's cookie: %v", err)
	}
	if f.exchanges != 0 {
		t.Fatal("no token exchange may happen for a bad state")
	}
	state = start(t, e, f)
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), state, "", "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a missing cookie: %v", err)
	}
	state = start(t, e, f)
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a state must work once: %v", err)
	}
	state = start(t, e, f)
	e.clock = e.clock.Add(11 * time.Minute)
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an expired state: %v", err)
	}
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), "", "", "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an empty state: %v", err)
	}
}

func TestGitHubOnlyTheLinkedNumericIDGetsIn(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 999) // someone else's GitHub account
	e.a.LinkGitHub("alice", 4242)
	state := start(t, e, f)
	if _, err := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unlinked GitHub id must be refused: %v", err)
	}
	f2 := newFakeGH(t, 4242)
	state = start(t, e, f2)
	if _, err := e.a.GitHubFinish(t.Context(), f2.config(), state, state, "wrong-code"); err == nil {
		t.Fatal("GitHub rejecting the code must fail the login")
	}
}

func TestPendingLoginExpiresAndWrongCodesAreThrottled(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 4242)
	e.a.LinkGitHub("alice", 4242)
	th := NewThrottle(func() time.Time { return e.clock })
	state := start(t, e, f)
	pending, _ := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code")
	e.clock = e.clock.Add(6 * time.Minute)
	if _, err := e.a.GitHubComplete(th, "9.9.9.9", "ua", pending, e.code()); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a pending login older than five minutes: %v", err)
	}
	state = start(t, e, f)
	pending, _ = e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code")
	for i := 0; i < 5; i++ {
		e.a.GitHubComplete(th, "8.8.8.8", "ua", pending, "000000")
	}
	var be *BlockedError
	if _, err := e.a.GitHubComplete(th, "8.8.8.8", "ua", pending, e.code()); !errors.As(err, &be) {
		t.Fatalf("five wrong codes must start the backoff: %v", err)
	}
	if _, err := e.a.GitHubComplete(th, "9.9.9.9", "ua", "garbage-pending-token", e.code()); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown pending token: %v", err)
	}
}

func directConfig(f *fakeGH, allowed ...int64) *GitHub {
	g := f.config()
	g.Direct, g.AllowedIDs = true, allowed
	return g
}

func TestGitHubDirectSignInGivesASessionWithoutACode(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 4242)
	e.a.LinkGitHub("alice", 4242)
	state := start(t, e, f)
	tok, err := e.a.GitHubSignIn(t.Context(), directConfig(f), "9.9.9.9", "ua", state, state, "good-code")
	if err != nil {
		t.Fatalf("sign-in: %v", err)
	}
	if u, ok := e.a.Session(tok); !ok || u.Username != "alice" {
		t.Fatalf("session: %+v %v", u, ok)
	}
}

func TestGitHubDirectKeepsTheStateRulesAndRefusesStrangers(t *testing.T) {
	e := newEnv(t)
	e.a.LinkGitHub("alice", 4242)
	f := newFakeGH(t, 4242)
	state := start(t, e, f)
	if _, err := e.a.GitHubSignIn(t.Context(), directConfig(f), "9.9.9.9", "ua", state, "other-browser-cookie", "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a state that does not match the cookie: %v", err)
	}
	stranger := newFakeGH(t, 999)
	state = start(t, e, stranger)
	if _, err := e.a.GitHubSignIn(t.Context(), directConfig(stranger), "9.9.9.9", "ua", state, state, "good-code"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unlinked, unlisted account must be refused: %v", err)
	}
	if n, _ := e.st.CountUsers(); n != 1 {
		t.Fatalf("a refused sign-in must not create a user, have %d", n)
	}
}

func TestGitHubDirectSignsUpAnAllowedAccountOnce(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 777)
	state := start(t, e, f)
	tok, err := e.a.GitHubSignIn(t.Context(), directConfig(f, 777), "9.9.9.9", "ua", state, state, "good-code")
	if err != nil {
		t.Fatalf("sign-up: %v", err)
	}
	u, ok := e.a.Session(tok)
	if !ok || u.Username != "gh-777" || u.GitHubID != 777 {
		t.Fatalf("new user: %+v %v", u, ok)
	}
	state = start(t, e, f)
	tok2, err := e.a.GitHubSignIn(t.Context(), directConfig(f, 777), "9.9.9.9", "ua", state, state, "good-code")
	if err != nil {
		t.Fatalf("second sign-in: %v", err)
	}
	if u2, _ := e.a.Session(tok2); u2.ID != u.ID {
		t.Fatal("the second sign-in must reuse the account")
	}
	if n, _ := e.st.CountUsers(); n != 2 {
		t.Fatalf("users: %d", n)
	}
}

// Behind the proxy all visitors share one address: bogus pending cookies must not lock the owner out.
func TestBogusPendingCookiesDoNotTouchTheThrottle(t *testing.T) {
	e := newEnv(t)
	f := newFakeGH(t, 4242)
	e.a.LinkGitHub("alice", 4242)
	th := NewThrottle(func() time.Time { return e.clock })
	const ip = "10.0.0.1" // the proxy: stranger and owner look the same
	for i := 0; i < 10; i++ {
		if _, err := e.a.GitHubComplete(th, ip, "ua", fmt.Sprintf("bogus-%d", i), "000000"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("bogus cookie %d: %v", i, err)
		}
	}
	state := start(t, e, f)
	pending, _ := e.a.GitHubFinish(t.Context(), f.config(), state, state, "good-code")
	if _, err := e.a.GitHubComplete(th, ip, "ua", pending, e.code()); err != nil {
		t.Fatalf("the owner must still get in after the bogus attempts: %v", err)
	}
}
