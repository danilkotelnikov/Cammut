package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"cammut/internal/store"
)

// GitHub holds one OAuth App's settings. The URL fields default to github.com and exist for tests.
type GitHub struct {
	ClientID, ClientSecret string
	RedirectURL            string
	AuthorizeURL, TokenURL string
	APIURL                 string
	HTTP                   *http.Client

	// Direct makes GitHub the whole sign-in: GitHub's own second factor stands in for the authenticator code.
	// AllowedIDs are the GitHub numeric ids that may sign up (a numeric id, unlike a login name, cannot be
	// taken over by someone who registers a name its owner dropped).
	Direct     bool
	AllowedIDs []int64
}

func (g GitHub) withDefaults() GitHub {
	if g.AuthorizeURL == "" {
		g.AuthorizeURL = "https://github.com/login/oauth/authorize"
	}
	if g.TokenURL == "" {
		g.TokenURL = "https://github.com/login/oauth/access_token"
	}
	if g.APIURL == "" {
		g.APIURL = "https://api.github.com"
	}
	if g.HTTP == nil {
		g.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
	return g
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// GitHubStart records a single-use state with its PKCE verifier and returns the authorize URL and the state
// the caller must also put in the browser's transaction cookie.
func (a *Auth) GitHubStart(g *GitHub) (authURL, state string, err error) {
	c := g.withDefaults()
	state, verifier := randomToken(32), randomToken(32)
	sum := sha256.Sum256([]byte(verifier))
	if err := a.st.PutOAuthState(store.HashToken(state), verifier, a.Now().Add(10*time.Minute)); err != nil {
		return "", "", err
	}
	q := url.Values{}
	q.Set("client_id", c.ClientID)
	q.Set("redirect_uri", c.RedirectURL)
	q.Set("scope", "read:user")
	q.Set("state", state)
	q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(sum[:]))
	q.Set("code_challenge_method", "S256")
	q.Set("allow_signup", "false")
	return c.AuthorizeURL + "?" + q.Encode(), state, nil
}

func (c GitHub) numericID(ctx context.Context, code, verifier string) (int64, error) {
	form := url.Values{"client_id": {c.ClientID}, "client_secret": {c.ClientSecret}, "code": {code}, "redirect_uri": {c.RedirectURL}, "code_verifier": {verifier}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, errors.New("github: token exchange failed")
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&tok); err != nil || tok.AccessToken == "" {
		return 0, errors.New("github: token exchange failed")
	}
	ureq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.APIURL+"/user", nil)
	if err != nil {
		return 0, err
	}
	ureq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	ureq.Header.Set("Accept", "application/vnd.github+json")
	ureq.Header.Set("User-Agent", "cammut")
	uresp, err := c.HTTP.Do(ureq)
	if err != nil {
		return 0, errors.New("github: could not read the account")
	}
	defer uresp.Body.Close()
	var u struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(uresp.Body, 1<<20)).Decode(&u); err != nil || u.ID == 0 {
		return 0, errors.New("github: could not read the account")
	}
	return u.ID, nil
}

// githubIdentity checks the callback (state must equal the browser's cookie and be unused and unexpired) and
// exchanges the code with PKCE. It returns the GitHub numeric id.
func (a *Auth) githubIdentity(ctx context.Context, g *GitHub, state, cookieState, code string) (int64, error) {
	if state == "" || len(state) > 200 || len(code) > 200 || subtle.ConstantTimeCompare([]byte(state), []byte(cookieState)) != 1 {
		return 0, ErrInvalid
	}
	verifier, ok, err := a.st.TakeOAuthState(store.HashToken(state), a.Now())
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrInvalid
	}
	return g.withDefaults().numericID(ctx, code, verifier)
}

// GitHubSignIn is the one-step login used when g.Direct is set: a linked account gets a session at once, and an
// account on g.AllowedIDs is created on its first visit. Anyone else is refused.
func (a *Auth) GitHubSignIn(ctx context.Context, g *GitHub, ip, ua, state, cookieState, code string) (string, error) {
	id, err := a.githubIdentity(ctx, g, state, cookieState, code)
	if err != nil {
		return "", err
	}
	u, found, err := a.st.UserByGitHubID(id)
	if err != nil {
		return "", err
	}
	if !found {
		if !slices.Contains(g.AllowedIDs, id) {
			return "", ErrInvalid
		}
		if u, err = a.signUpGitHub(id); err != nil {
			return "", err
		}
	}
	token, hash := newSessionToken()
	now := a.Now()
	if err := a.st.CreateSession(u.ID, store.NewSession{IDHash: hash, Now: now, ExpiresAt: a.expiry(now, now), IP: ip, UAHash: shortHash(ua)}); err != nil {
		return "", err
	}
	return token, nil
}

// signUpGitHub makes the account for an allowed GitHub id. Its password is random and thrown away, and its
// authenticator is never shown, so GitHub is the only way in.
func (a *Auth) signUpGitHub(id int64) (store.User, error) {
	name := "gh-" + strconv.FormatInt(id, 10)
	// an account left half-made by an earlier failure (made, never linked) is finished instead of failing forever
	if _, exists, err := a.st.UserByName(name); err != nil {
		return store.User{}, err
	} else if !exists {
		if _, err := a.CreateUser(name, randomToken(32)); err != nil {
			return store.User{}, err
		}
	}
	u, ok, err := a.st.UserByName(name)
	if err != nil || !ok {
		return store.User{}, errors.New("github: sign-up failed")
	}
	if err := a.st.SetGitHubID(u.ID, id); err != nil {
		return store.User{}, err
	}
	u.GitHubID = id
	return u, nil
}

// GitHubFinish checks the callback and, when the GitHub numeric id is the linked one, returns a pending-login
// token. It never returns a session: the authenticator code is still required (GitHubComplete).
func (a *Auth) GitHubFinish(ctx context.Context, g *GitHub, state, cookieState, code string) (string, error) {
	id, err := a.githubIdentity(ctx, g, state, cookieState, code)
	if err != nil {
		return "", err
	}
	u, found, err := a.st.UserByGitHubID(id)
	if err != nil {
		return "", err
	}
	if !found {
		return "", ErrInvalid
	}
	token, hash := newSessionToken()
	if err := a.st.PutPending(hash, u.ID, a.Now().Add(5*time.Minute)); err != nil {
		return "", err
	}
	return token, nil
}

// GitHubComplete turns a pending login plus a TOTP or recovery code into a session.
func (a *Auth) GitHubComplete(th *Throttle, ip, ua, pending, code string) (string, error) {
	// A missing or unknown pending cookie costs nothing: behind the proxy every visitor shares one address, so
	// counting these would let a stranger lock the owner out. Only a real pending login can reach the throttle.
	if len(pending) > 100 {
		return "", ErrInvalid
	}
	uid, ok, err := a.st.PendingUser(store.HashToken(pending), a.Now())
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrInvalid
	}
	if wait, ok := th.Check(ip); !ok {
		return "", &BlockedError{RetryAfter: wait}
	}
	if len(code) > 32 {
		th.Fail(ip)
		return "", ErrInvalid
	}
	u, found, err := a.st.UserByID(uid)
	if err != nil {
		return "", err
	}
	if !found {
		th.Fail(ip)
		return "", ErrInvalid
	}
	proof, ok := a.secondFactor(u, code)
	if !ok {
		th.Fail(ip)
		return "", ErrInvalid
	}
	token, err := a.finish(ip, ua, u, proof)
	if err != nil {
		if errors.Is(err, ErrInvalid) {
			th.Fail(ip)
		}
		return "", err
	}
	_ = a.st.DeletePending(store.HashToken(pending))
	th.Clear(ip)
	return token, nil
}
