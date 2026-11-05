// Package store is Cammut's SQLite persistence: tokens, upstreams, the audit log, users, sessions and secrets.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL, hash TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS upstreams(
  name TEXT PRIMARY KEY, url TEXT NOT NULL, bearer_env TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, token_id INTEGER, upstream TEXT, tool TEXT,
  ok INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);`

func Open(path string) (*Store, error) {
	// _txlock=immediate: every transaction takes the write lock when it begins, so a concurrent writer is waited for by the
	// busy timeout. A deferred transaction that reads before it writes can instead fail at once with SQLITE_BUSY_SNAPSHOT
	// (517) when another connection commits in between, which the busy timeout cannot retry.
	dsn := "file:" + path + "?_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// DB exposes the connection pool to packages that own their own tables (the raw archive).
func (s *Store) DB() *sql.DB { return s.db }

// Snapshot writes a consistent copy of the live database to path (VACUUM INTO: one read transaction, so it is safe
// while the gateway keeps writing in WAL mode). The file must not exist.
func (s *Store) Snapshot(path string) error {
	_, err := s.db.Exec(`VACUUM INTO ?`, path)
	return err
}

var (
	labelRe   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,40}$`)
	scopeRe   = regexp.MustCompile(`^[A-Za-z0-9._*/-]{1,80}$`)
	nameRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	envRe     = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	profileRe = regexp.MustCompile(`^(lazy|direct:[a-z0-9][a-z0-9-]{0,31})$`)
)

// Token is an agent credential record. The plaintext is never stored.
type Token struct {
	ID         int64
	Label      string
	Scopes     []string
	Revoked    bool
	CreatedAt  time.Time
	LastUsedAt time.Time
	ExpiresAt  time.Time // zero means it never expires
	Profile    string    // "lazy" or "direct:<upstream>"
}

// HashToken is the stored form of a token or session secret: hex SHA-256.
func HashToken(plain string) string {
	h := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(h[:])
}

// CreateToken mints a never-expiring lazy-profile token and returns its plaintext exactly once.
func (s *Store) CreateToken(label string, scopes []string) (string, Token, error) {
	return s.CreateTokenOpts(label, scopes, time.Time{}, "lazy")
}

// CreateTokenOpts is CreateToken with an optional expiry (zero = never) and a profile.
func (s *Store) CreateTokenOpts(label string, scopes []string, expires time.Time, profile string) (string, Token, error) {
	if !labelRe.MatchString(label) {
		return "", Token{}, fmt.Errorf("invalid label %q (use letters, digits, . _ -)", label)
	}
	if !profileRe.MatchString(profile) {
		return "", Token{}, fmt.Errorf("invalid profile %q", profile)
	}
	if scopes == nil {
		scopes = []string{}
	}
	for _, sc := range scopes {
		if !scopeRe.MatchString(sc) {
			return "", Token{}, fmt.Errorf("invalid scope %q", sc)
		}
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", Token{}, err
	}
	plain := "cmt_" + hex.EncodeToString(b)
	js, _ := json.Marshal(scopes)
	now := time.Now()
	var exp any
	if !expires.IsZero() {
		exp = expires.Unix()
	}
	res, err := s.db.Exec(`INSERT INTO tokens(label,hash,scopes,created_at,expires_at,profile) VALUES(?,?,?,?,?,?)`,
		label, HashToken(plain), string(js), now.Unix(), exp, profile)
	if err != nil {
		return "", Token{}, err
	}
	id, _ := res.LastInsertId()
	return plain, Token{ID: id, Label: label, Scopes: scopes, CreatedAt: now, ExpiresAt: expires, Profile: profile}, nil
}

// VerifyToken looks a plaintext token up by its hash. Revoked and expired tokens never verify.
// last_used_at is refreshed at most once a minute so authenticated traffic does not become a write per request.
func (s *Store) VerifyToken(plain string) (Token, bool, error) {
	var (
		t       Token
		js      string
		created int64
		last    sql.NullInt64
		expires sql.NullInt64
		revoked int
	)
	// The index lookup on the SHA-256 of the presented token reveals nothing exploitable about the token itself (the
	// attacker cannot steer a hash), and the stored digest is compared in constant time before anything is trusted.
	want := HashToken(plain)
	var stored string
	err := s.db.QueryRow(`SELECT id,label,scopes,created_at,last_used_at,revoked,expires_at,profile,hash FROM tokens WHERE hash=?`,
		want).Scan(&t.ID, &t.Label, &js, &created, &last, &revoked, &expires, &t.Profile, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		return Token{}, false, nil
	}
	if err != nil {
		return Token{}, false, err
	}
	if subtle.ConstantTimeCompare([]byte(stored), []byte(want)) != 1 || revoked != 0 {
		return Token{}, false, nil
	}
	if expires.Valid {
		t.ExpiresAt = time.Unix(expires.Int64, 0)
		if !time.Now().Before(t.ExpiresAt) {
			return Token{}, false, nil
		}
	}
	if err := json.Unmarshal([]byte(js), &t.Scopes); err != nil {
		return Token{}, false, err
	}
	t.CreatedAt = time.Unix(created, 0)
	if now := time.Now().Unix(); !last.Valid || now-last.Int64 >= 60 {
		_, _ = s.db.Exec(`UPDATE tokens SET last_used_at=? WHERE id=?`, now, t.ID)
	}
	return t, true, nil
}

// SetScopes replaces the scopes of an active token. The token string itself is unchanged.
func (s *Store) SetScopes(label string, scopes []string) (bool, error) {
	if scopes == nil {
		scopes = []string{}
	}
	for _, sc := range scopes {
		if !scopeRe.MatchString(sc) {
			return false, fmt.Errorf("invalid scope %q", sc)
		}
	}
	js, _ := json.Marshal(scopes)
	res, err := s.db.Exec(`UPDATE tokens SET scopes=? WHERE label=? AND revoked=0`, string(js), label)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

const tokenCols = `id,label,scopes,created_at,last_used_at,revoked,expires_at,profile`

func scanToken(row interface{ Scan(...any) error }) (Token, error) {
	var (
		t       Token
		js      string
		created int64
		last    sql.NullInt64
		expires sql.NullInt64
		revoked int
	)
	if err := row.Scan(&t.ID, &t.Label, &js, &created, &last, &revoked, &expires, &t.Profile); err != nil {
		return Token{}, err
	}
	_ = json.Unmarshal([]byte(js), &t.Scopes)
	t.CreatedAt = time.Unix(created, 0)
	if last.Valid {
		t.LastUsedAt = time.Unix(last.Int64, 0)
	}
	if expires.Valid {
		t.ExpiresAt = time.Unix(expires.Int64, 0)
	}
	t.Revoked = revoked != 0
	return t, nil
}

func (s *Store) ListTokens() ([]Token, error) {
	rows, err := s.db.Query(`SELECT ` + tokenCols + ` FROM tokens ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) TokenByLabel(label string) (Token, bool, error) {
	t, err := scanToken(s.db.QueryRow(`SELECT `+tokenCols+` FROM tokens WHERE label=?`, label))
	if errors.Is(err, sql.ErrNoRows) {
		return Token{}, false, nil
	}
	return t, err == nil, err
}

func (s *Store) RevokeToken(label string) (bool, error) {
	res, err := s.db.Exec(`UPDATE tokens SET revoked=1 WHERE label=? AND revoked=0`, label)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Upstream is a registered MCP server. BearerSecret names a vault entry and BearerEnv an environment
// variable; the vault wins when both resolve.
type Upstream struct {
	Name         string
	URL          string
	BearerEnv    string
	BearerSecret string
	AuthHeader   string // "" sends "Authorization: Bearer <key>"; any other header name sends the bare key under that name (Composio wants x-api-key)
	Enabled      bool
}

var headerRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,63}$`)

// reservedHeaders are the ones the transport or the MCP protocol own; a key must never overwrite them.
var reservedHeaders = []string{"host", "content-length", "content-type", "accept", "transfer-encoding", "connection", "mcp-session-id", "mcp-protocol-version"}

// ValidateUpstream checks names and rejects link-local and metadata targets.
// Loopback is allowed because the admin CLI is trusted and Hindsight/OpenViking live there.
// ponytail: literal IPs and the GCP metadata host are checked; DNS names that resolve to link-local are not.
func ValidateUpstream(u Upstream) error {
	metadataIPs := []net.IP{net.ParseIP("100.100.100.200"), net.ParseIP("168.63.129.16"), net.ParseIP("fd00:ec2::254")} // Alibaba, Azure, AWS IPv6 // privacy-scan: allow
	if !nameRe.MatchString(u.Name) {
		return fmt.Errorf("invalid upstream name %q (lowercase letters, digits, '-')", u.Name)
	}
	if u.Name == "llm" {
		return fmt.Errorf("the upstream name %q is reserved for the LLM gateway (its scopes are llm/...)", u.Name)
	}
	pu, err := url.Parse(u.URL)
	if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Hostname() == "" {
		return fmt.Errorf("invalid upstream url %q (need http(s)://host/...)", u.URL)
	}
	host := pu.Hostname()
	if strings.EqualFold(host, "metadata.google.internal") {
		return errors.New("metadata hosts are not allowed")
	}
	if ip := net.ParseIP(host); ip != nil {
		blocked := ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
		for _, m := range metadataIPs {
			blocked = blocked || ip.Equal(m)
		}
		if blocked {
			return fmt.Errorf("address %s is not allowed", host)
		}
	}
	if u.BearerEnv != "" && !envRe.MatchString(u.BearerEnv) {
		return fmt.Errorf("invalid bearer env name %q", u.BearerEnv)
	}
	if u.BearerSecret != "" && !envRe.MatchString(u.BearerSecret) {
		return fmt.Errorf("invalid bearer secret name %q", u.BearerSecret)
	}
	if u.AuthHeader != "" {
		if !headerRe.MatchString(u.AuthHeader) {
			return fmt.Errorf("invalid key header name %q (letters, digits and dashes)", u.AuthHeader)
		}
		for _, r := range reservedHeaders {
			if strings.EqualFold(u.AuthHeader, r) {
				return fmt.Errorf("the header %q cannot carry a key", u.AuthHeader)
			}
		}
	}
	return nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) AddUpstream(u Upstream) error {
	if err := ValidateUpstream(u); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO upstreams(name,url,bearer_env,bearer_secret,auth_header,enabled,created_at) VALUES(?,?,?,?,?,?,?)
ON CONFLICT(name) DO UPDATE SET url=excluded.url, bearer_env=excluded.bearer_env, bearer_secret=excluded.bearer_secret, auth_header=excluded.auth_header, enabled=excluded.enabled`,
		u.Name, u.URL, u.BearerEnv, u.BearerSecret, u.AuthHeader, b2i(u.Enabled), time.Now().Unix())
	return err
}

func (s *Store) ListUpstreams() ([]Upstream, error) {
	rows, err := s.db.Query(`SELECT name,url,bearer_env,bearer_secret,auth_header,enabled FROM upstreams ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Upstream
	for rows.Next() {
		var u Upstream
		var en int
		if err := rows.Scan(&u.Name, &u.URL, &u.BearerEnv, &u.BearerSecret, &u.AuthHeader, &en); err != nil {
			return nil, err
		}
		u.Enabled = en != 0
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) GetUpstream(name string) (Upstream, bool, error) {
	var u Upstream
	var en int
	err := s.db.QueryRow(`SELECT name,url,bearer_env,bearer_secret,auth_header,enabled FROM upstreams WHERE name=?`, name).
		Scan(&u.Name, &u.URL, &u.BearerEnv, &u.BearerSecret, &u.AuthHeader, &en)
	if errors.Is(err, sql.ErrNoRows) {
		return Upstream{}, false, nil
	}
	u.Enabled = en != 0
	return u, err == nil, err
}

func (s *Store) SetUpstreamEnabled(name string, enabled bool) (bool, error) {
	res, err := s.db.Exec(`UPDATE upstreams SET enabled=? WHERE name=?`, b2i(enabled), name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) RemoveUpstream(name string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM upstreams WHERE name=?`, name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Audit is one record. Tool-call arguments are never stored. Actor is "user:<name>", "assistant:<run>" or empty
// for gateway calls; IP is the client address when known.
type Audit struct {
	TS       time.Time
	TokenID  int64
	Upstream string
	Tool     string
	OK       bool
	Millis   int64
	Note     string
	IP       string
	Actor    string
}

func (s *Store) AddAudit(a Audit) error {
	_, err := s.db.Exec(`INSERT INTO audit(ts,token_id,upstream,tool,ok,ms,note,ip,actor) VALUES(?,?,?,?,?,?,?,?,?)`,
		a.TS.Unix(), a.TokenID, a.Upstream, a.Tool, b2i(a.OK), a.Millis, a.Note, a.IP, a.Actor)
	return err
}

type AuditFilter struct {
	TokenID  int64
	Upstream string
	Tool     string // substring match
	OK       *bool
	Since    time.Time
	Until    time.Time
	Limit    int // default 100, capped at 500
	Offset   int
}

func (s *Store) QueryAudit(f AuditFilter) ([]Audit, error) {
	var where []string
	var args []any
	if f.TokenID != 0 {
		where, args = append(where, "token_id=?"), append(args, f.TokenID)
	}
	if f.Upstream != "" {
		where, args = append(where, "upstream=?"), append(args, f.Upstream)
	}
	if f.Tool != "" {
		where, args = append(where, "instr(tool,?)>0"), append(args, f.Tool)
	}
	if f.OK != nil {
		where, args = append(where, "ok=?"), append(args, b2i(*f.OK))
	}
	if !f.Since.IsZero() {
		where, args = append(where, "ts>=?"), append(args, f.Since.Unix())
	}
	if !f.Until.IsZero() {
		where, args = append(where, "ts<?"), append(args, f.Until.Unix())
	}
	q := `SELECT ts,COALESCE(token_id,0),COALESCE(upstream,''),COALESCE(tool,''),ok,ms,COALESCE(note,''),ip,actor FROM audit`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	q += " ORDER BY id DESC LIMIT ? OFFSET ?"
	args = append(args, limit, f.Offset)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Audit
	for rows.Next() {
		var a Audit
		var ts int64
		var ok int
		if err := rows.Scan(&ts, &a.TokenID, &a.Upstream, &a.Tool, &ok, &a.Millis, &a.Note, &a.IP, &a.Actor); err != nil {
			return nil, err
		}
		a.TS, a.OK = time.Unix(ts, 0), ok != 0
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) RecentAudit(limit int) ([]Audit, error) {
	return s.QueryAudit(AuditFilter{Limit: limit})
}

func (s *Store) PruneAudit(before time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM audit WHERE ts < ?`, before.Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
