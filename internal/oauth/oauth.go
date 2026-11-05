// Package oauth lets an MCP client such as the Gemini app connect to Cammut with the standard OAuth authorization-code
// flow. The owner creates the client in the console (a Client ID and a Client secret, shown once), the client sends the
// browser to /oauth/authorize, the owner says yes in the console, and the client trades the one-time code for an access
// token and a refresh token. The access token is an ordinary Cammut token (scoped, listed and revocable in the console)
// that lasts a year; the refresh token never expires and mints the next one, so the client does not ask for a sign-in again.
package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"cammut/internal/store"
)

const (
	// AccessLife is how long one access token lasts; the refresh token asks for the next before it ends.
	AccessLife  = 365 * 24 * time.Hour
	requestLife = 10 * time.Minute
	codeLife    = 2 * time.Minute
	maxPending  = 200
	maxClients  = 50

	maxPendingPerClient = 20
	refreshIdleLife     = 365 * 24 * time.Hour // a refresh token unused this long stops working
)

var (
	ErrBadInput      = errors.New("bad input")
	ErrNotFound      = errors.New("not found")
	ErrInvalidClient = errors.New("invalid client")
	ErrInvalidGrant  = errors.New("invalid grant")
	ErrBusy          = errors.New("too many pending requests")
)

var (
	scopeRe     = regexp.MustCompile(`^[A-Za-z0-9._*/-]{1,80}$`)
	verifierRe  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
	challengeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

// Who names the person behind a change, for the audit log.
type Who struct{ Actor, IP string }

type Service struct {
	st  *store.Store
	db  *sql.DB
	now func() time.Time
}

func New(st *store.Store) *Service {
	return &Service{st: st, db: st.DB(), now: time.Now}
}

func random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS random source failing is not recoverable
	}
	return hex.EncodeToString(b)
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// audit never stores more than a short line: callers outside the console can put anything in a request.
func (s *Service) audit(w Who, tool string, ok bool, note string) {
	_ = s.st.AddAudit(store.Audit{TS: s.now(), Upstream: "oauth", Tool: tool, OK: ok, Note: clip(note, 100), IP: clip(w.IP, 64), Actor: clip(w.Actor, 100)})
}

// ---- clients ----

type Grant struct {
	ID         int64
	CreatedAt  time.Time
	LastUsedAt time.Time
}

type Client struct {
	ID           string
	Name         string
	RedirectURIs []string
	Scopes       []string
	CreatedAt    time.Time
	Revoked      bool
	Grants       []Grant
}

func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Fragment != "" || u.User != nil || len(raw) > 500 {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	h := u.Hostname()
	return u.Scheme == "http" && (h == "localhost" || h == "127.0.0.1" || h == "::1")
}

func cleanRedirects(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, r := range in {
		r = strings.TrimSpace(r)
		if r == "" || seen[r] {
			continue
		}
		if !validRedirect(r) {
			return nil, fmt.Errorf("%w: %q is not an https address", ErrBadInput, r)
		}
		seen[r] = true
		out = append(out, r)
	}
	if len(out) > 10 {
		return nil, fmt.Errorf("%w: at most 10 redirect addresses", ErrBadInput)
	}
	return out, nil
}

// CreateClient makes a client and returns its secret exactly once; only a hash is stored.
func (s *Service) CreateClient(w Who, name string, redirects, scopes []string) (Client, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 60 {
		return Client{}, "", fmt.Errorf("%w: the name needs 1 to 60 characters", ErrBadInput)
	}
	if len(scopes) == 0 {
		return Client{}, "", fmt.Errorf("%w: choose at least one scope", ErrBadInput)
	}
	for _, sc := range scopes {
		if !scopeRe.MatchString(sc) {
			return Client{}, "", fmt.Errorf("%w: invalid scope %q", ErrBadInput, sc)
		}
	}
	rs, err := cleanRedirects(redirects)
	if err != nil {
		return Client{}, "", err
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM oauth_clients WHERE revoked=0`).Scan(&n); err != nil {
		return Client{}, "", err
	}
	if n >= maxClients {
		return Client{}, "", fmt.Errorf("%w: too many apps; remove one first", ErrBadInput)
	}
	id, secret := "cmc_"+random(8), "cms_"+random(32)
	rj, _ := json.Marshal(rs)
	sj, _ := json.Marshal(scopes)
	now := s.now()
	if _, err := s.db.Exec(`INSERT INTO oauth_clients(id,name,secret_hash,redirect_uris,scopes,created_at) VALUES(?,?,?,?,?,?)`,
		id, name, store.HashToken(secret), string(rj), string(sj), now.Unix()); err != nil {
		return Client{}, "", err
	}
	s.audit(w, "client.create", true, id+" "+name)
	return Client{ID: id, Name: name, RedirectURIs: rs, Scopes: scopes, CreatedAt: now}, secret, nil
}

// SetRedirects replaces the registered redirect addresses of a client.
func (s *Service) SetRedirects(w Who, id string, redirects []string) error {
	rs, err := cleanRedirects(redirects)
	if err != nil {
		return err
	}
	rj, _ := json.Marshal(rs)
	res, err := s.db.Exec(`UPDATE oauth_clients SET redirect_uris=? WHERE id=? AND revoked=0`, string(rj), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrNotFound
	}
	s.audit(w, "client.redirects", true, id)
	return nil
}

func scanClient(row interface{ Scan(...any) error }) (Client, string, error) {
	var c Client
	var rj, sj, hash string
	var created int64
	var revoked int
	if err := row.Scan(&c.ID, &c.Name, &hash, &rj, &sj, &created, &revoked); err != nil {
		return Client{}, "", err
	}
	_ = json.Unmarshal([]byte(rj), &c.RedirectURIs)
	_ = json.Unmarshal([]byte(sj), &c.Scopes)
	c.CreatedAt, c.Revoked = time.Unix(created, 0), revoked != 0
	return c, hash, nil
}

const clientCols = `id,name,secret_hash,redirect_uris,scopes,created_at,revoked`

func (s *Service) client(id string) (Client, string, bool, error) {
	c, hash, err := scanClient(s.db.QueryRow(`SELECT `+clientCols+` FROM oauth_clients WHERE id=? AND revoked=0`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Client{}, "", false, nil
	}
	return c, hash, err == nil, err
}

// Clients lists the active clients with their live connections.
func (s *Service) Clients() ([]Client, error) {
	rows, err := s.db.Query(`SELECT ` + clientCols + ` FROM oauth_clients WHERE revoked=0 ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	var out []Client
	for rows.Next() {
		c, _, err := scanClient(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		g, err := s.db.Query(`SELECT id,created_at,last_used_at FROM oauth_grants WHERE client_id=? ORDER BY id`, out[i].ID)
		if err != nil {
			return nil, err
		}
		for g.Next() {
			var gr Grant
			var created int64
			var used sql.NullInt64
			if err := g.Scan(&gr.ID, &created, &used); err != nil {
				g.Close()
				return nil, err
			}
			gr.CreatedAt = time.Unix(created, 0)
			if used.Valid {
				gr.LastUsedAt = time.Unix(used.Int64, 0)
			}
			out[i].Grants = append(out[i].Grants, gr)
		}
		g.Close()
	}
	return out, nil
}

// RevokeClient removes a client, every connection it holds and every token those connections minted.
func (s *Service) RevokeClient(w Who, id string) error {
	res, err := s.db.Exec(`UPDATE oauth_clients SET revoked=1 WHERE id=? AND revoked=0`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrNotFound
	}
	// every token a connection of this client ever received carries the client's prefix, so none can be orphaned
	if _, err := s.db.Exec(`UPDATE tokens SET revoked=1 WHERE label LIKE ? AND revoked=0`, tokenPrefix(id)+"%"); err != nil {
		return err
	}
	for _, q := range []string{`DELETE FROM oauth_grants WHERE client_id=?`, `DELETE FROM oauth_requests WHERE client_id=?`, `DELETE FROM oauth_codes WHERE client_id=?`} {
		if _, err := s.db.Exec(q, id); err != nil {
			return err
		}
	}
	s.audit(w, "client.revoke", true, id)
	return nil
}

// RevokeGrant ends one connection of a client and its current access token.
func (s *Service) RevokeGrant(w Who, id int64) error {
	var label, cid string
	err := s.db.QueryRow(`SELECT token_label,client_id FROM oauth_grants WHERE id=?`, id).Scan(&label, &cid)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	_, _ = s.st.RevokeToken(label)
	if _, err := s.db.Exec(`DELETE FROM oauth_grants WHERE id=?`, id); err != nil {
		return err
	}
	s.audit(w, "grant.revoke", true, cid)
	return nil
}

// authClient checks the client secret in constant time.
func (s *Service) authClient(id, secret string) (Client, error) {
	c, hash, ok, err := s.client(id)
	if err != nil {
		return Client{}, err
	}
	if !ok || secret == "" || !same(hash, store.HashToken(secret)) {
		return Client{}, ErrInvalidClient
	}
	return c, nil
}

// ---- the authorization request ----

// AuthParams are the query parameters of /oauth/authorize that Begin needs.
type AuthParams struct{ ClientID, RedirectURI, State, Challenge string }

// ClientFor returns the active client with that id.
func (s *Service) ClientFor(id string) (Client, bool, error) {
	c, _, ok, err := s.client(id)
	return c, ok, err
}

// Begin records an authorization request for the owner to answer in the console and returns its id.
func (s *Service) Begin(p AuthParams) (string, error) {
	c, ok, err := s.ClientFor(p.ClientID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrInvalidClient
	}
	found := false
	for _, r := range c.RedirectURIs {
		if r == p.RedirectURI {
			found = true
		}
	}
	if !found {
		return "", ErrInvalidClient
	}
	now := s.now()
	_, _ = s.db.Exec(`DELETE FROM oauth_requests WHERE expires_at<=?`, now.Unix())
	_, _ = s.db.Exec(`DELETE FROM oauth_codes WHERE expires_at<=?`, now.Unix())
	var n, mine int
	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(client_id=?),0) FROM oauth_requests`, p.ClientID).Scan(&n, &mine); err != nil {
		return "", err
	}
	if n >= maxPending || mine >= maxPendingPerClient {
		return "", ErrBusy
	}
	id := random(16)
	if _, err := s.db.Exec(`INSERT INTO oauth_requests(id,client_id,redirect_uri,state,challenge,expires_at) VALUES(?,?,?,?,?,?)`,
		id, p.ClientID, p.RedirectURI, p.State, p.Challenge, now.Add(requestLife).Unix()); err != nil {
		return "", err
	}
	return id, nil
}

// RequestInfo is what the consent page shows.
type RequestInfo struct {
	ClientName   string
	Scopes       []string
	RedirectHost string
}

type pending struct {
	clientID, redirect, state, challenge string
}

func (s *Service) loadRequest(id string) (pending, error) {
	var p pending
	var exp int64
	err := s.db.QueryRow(`SELECT client_id,redirect_uri,state,challenge,expires_at FROM oauth_requests WHERE id=?`, id).
		Scan(&p.clientID, &p.redirect, &p.state, &p.challenge, &exp)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !s.now().Before(time.Unix(exp, 0))) {
		return pending{}, ErrNotFound
	}
	return p, err
}

// Request describes a waiting authorization request.
func (s *Service) Request(id string) (RequestInfo, error) {
	p, err := s.loadRequest(id)
	if err != nil {
		return RequestInfo{}, err
	}
	c, ok, err := s.ClientFor(p.clientID)
	if err != nil {
		return RequestInfo{}, err
	}
	if !ok {
		return RequestInfo{}, ErrNotFound
	}
	host := ""
	if u, err := url.Parse(p.redirect); err == nil {
		host = u.Host
	}
	return RequestInfo{ClientName: c.Name, Scopes: c.Scopes, RedirectHost: host}, nil
}

// Redirect appends parameters to a registered redirect address, keeping the query it already had.
func Redirect(base string, params map[string]string) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	for k, v := range params {
		if v != "" {
			q.Set(k, v)
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// Approve answers yes: it spends the request, stores a one-time code and returns the address to send the browser to.
func (s *Service) Approve(w Who, id string, userID int64) (string, error) {
	p, err := s.loadRequest(id)
	if err != nil {
		return "", err
	}
	res, err := s.db.Exec(`DELETE FROM oauth_requests WHERE id=?`, id)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", ErrNotFound
	}
	c, ok, err := s.ClientFor(p.clientID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrNotFound
	}
	sj, _ := json.Marshal(c.Scopes)
	code := random(32)
	if _, err := s.db.Exec(`INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,challenge,scopes,expires_at) VALUES(?,?,?,?,?,?,?)`,
		store.HashToken(code), p.clientID, userID, p.redirect, p.challenge, string(sj), s.now().Add(codeLife).Unix()); err != nil {
		return "", err
	}
	s.audit(w, "authorize", true, p.clientID)
	return Redirect(p.redirect, map[string]string{"code": code, "state": p.state}), nil
}

// Deny answers no.
func (s *Service) Deny(w Who, id string) (string, error) {
	p, err := s.loadRequest(id)
	if err != nil {
		return "", err
	}
	if _, err := s.db.Exec(`DELETE FROM oauth_requests WHERE id=?`, id); err != nil {
		return "", err
	}
	s.audit(w, "authorize", false, p.clientID+" denied")
	return Redirect(p.redirect, map[string]string{"error": "access_denied", "state": p.state}), nil
}

// ---- tokens ----

type Tokens struct {
	Access  string
	Refresh string
	Scopes  []string
	Expires time.Duration
}

// tokenPrefix starts the label of every access token a client's connections receive, so a whole client can be revoked at once.
func tokenPrefix(clientID string) string {
	return "oauth-" + strings.TrimPrefix(clientID, "cmc_") + "-"
}

func (s *Service) mint(clientID string, scopes []string) (access, label string, err error) {
	label = tokenPrefix(clientID) + random(4)
	access, _, err = s.st.CreateTokenOpts(label, scopes, s.now().Add(AccessLife), "lazy")
	return access, label, err
}

// Exchange trades a one-time code for tokens.
func (s *Service) Exchange(w Who, clientID, secret, code, redirectURI, verifier string) (Tokens, error) {
	c, err := s.authClient(clientID, secret)
	if err != nil {
		w.Actor = "client:?" // the id came from an unauthenticated caller
		s.audit(w, "token", false, "bad client")
		return Tokens{}, err
	}
	w.Actor = "client:" + c.ID
	var cid, redirect, challenge, sj string
	var userID, exp int64
	// One statement spends the code: of two concurrent exchanges exactly one gets the row.
	err = s.db.QueryRow(`DELETE FROM oauth_codes WHERE code_hash=? RETURNING client_id,user_id,redirect_uri,challenge,scopes,expires_at`, store.HashToken(code)).
		Scan(&cid, &userID, &redirect, &challenge, &sj, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		s.audit(w, "token", false, "unknown code")
		return Tokens{}, ErrInvalidGrant
	}
	if err != nil {
		return Tokens{}, err
	}
	bad := func(why string) (Tokens, error) {
		s.audit(w, "token", false, why)
		return Tokens{}, ErrInvalidGrant
	}
	if cid != c.ID || redirect != redirectURI || !s.now().Before(time.Unix(exp, 0)) {
		return bad("code does not match")
	}
	if challenge != "" {
		if !verifierRe.MatchString(verifier) {
			return bad("missing verifier")
		}
		h := sha256.Sum256([]byte(verifier))
		if !same(challenge, base64.RawURLEncoding.EncodeToString(h[:])) {
			return bad("wrong verifier")
		}
	}
	var scopes []string
	_ = json.Unmarshal([]byte(sj), &scopes)
	access, label, err := s.mint(c.ID, scopes)
	if err != nil {
		return Tokens{}, err
	}
	refresh := "cmr_" + random(32)
	// The grant is written only while the client is still active, so a client revoked a moment ago gets nothing.
	res, err := s.db.Exec(`INSERT INTO oauth_grants(client_id,user_id,scopes,token_label,refresh_hash,created_at,last_used_at)
SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM oauth_clients WHERE id=? AND revoked=0)`,
		c.ID, userID, sj, label, store.HashToken(refresh), s.now().Unix(), s.now().Unix(), c.ID)
	if err == nil {
		if n, _ := res.RowsAffected(); n != 1 {
			err = ErrInvalidClient
		}
	}
	if err != nil {
		_, _ = s.st.RevokeToken(label)
		return Tokens{}, err
	}
	s.audit(w, "token", true, "issued")
	return Tokens{Access: access, Refresh: refresh, Scopes: scopes, Expires: AccessLife}, nil
}

// Refresh mints the next access token. The refresh token stays the same: a lost reply cannot lock the client out,
// and the owner can end the connection at any time from the console. A connection whose current token the owner
// revoked (for instance on the Tokens page) is over, and one idle for a year is over too.
func (s *Service) Refresh(w Who, clientID, secret, refresh string) (Tokens, error) {
	c, err := s.authClient(clientID, secret)
	if err != nil {
		w.Actor = "client:?"
		s.audit(w, "refresh", false, "bad client")
		return Tokens{}, err
	}
	w.Actor = "client:" + c.ID
	var id int64
	var oldLabel, sj string
	var used sql.NullInt64
	err = s.db.QueryRow(`SELECT id,token_label,scopes,last_used_at FROM oauth_grants WHERE refresh_hash=? AND client_id=?`, store.HashToken(refresh), c.ID).
		Scan(&id, &oldLabel, &sj, &used)
	if errors.Is(err, sql.ErrNoRows) {
		s.audit(w, "refresh", false, "unknown refresh token")
		return Tokens{}, ErrInvalidGrant
	}
	if err != nil {
		return Tokens{}, err
	}
	end := func(why string) (Tokens, error) {
		_, _ = s.db.Exec(`DELETE FROM oauth_grants WHERE id=?`, id)
		s.audit(w, "refresh", false, why)
		return Tokens{}, ErrInvalidGrant
	}
	if used.Valid && s.now().Sub(time.Unix(used.Int64, 0)) > refreshIdleLife {
		return end("idle too long")
	}
	if cur, ok, err := s.st.TokenByLabel(oldLabel); err != nil {
		return Tokens{}, err
	} else if !ok || cur.Revoked {
		return end("token was revoked")
	}
	var scopes []string
	_ = json.Unmarshal([]byte(sj), &scopes)
	access, label, err := s.mint(c.ID, scopes)
	if err != nil {
		return Tokens{}, err
	}
	// compare-and-swap: of two concurrent refreshes only one moves the grant on; the other's token is revoked at once
	res, err := s.db.Exec(`UPDATE oauth_grants SET token_label=?, last_used_at=? WHERE id=? AND token_label=?`, label, s.now().Unix(), id, oldLabel)
	if err == nil {
		if n, _ := res.RowsAffected(); n != 1 {
			err = ErrInvalidGrant
		}
	}
	if err != nil {
		_, _ = s.st.RevokeToken(label)
		return Tokens{}, err
	}
	_, _ = s.st.RevokeToken(oldLabel)
	s.audit(w, "refresh", true, "ok")
	return Tokens{Access: access, Refresh: refresh, Scopes: scopes, Expires: AccessLife}, nil
}
