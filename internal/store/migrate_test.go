package store

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestMigrationsUpgradeAnOldDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(schema); err != nil { // the schema the 0.1.2 binary created
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO tokens(label,hash,scopes,created_at) VALUES('legacy',?,'["a/*"]',1)`, HashToken("cmt_legacy")); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO upstreams(name,url,bearer_env,enabled,created_at) VALUES('u','http://127.0.0.1:1/mcp','K',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`INSERT INTO audit(ts,token_id,upstream,tool,ok,ms,note) VALUES(1,1,'u','t',1,5,'')`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tok, ok, err := s.VerifyToken("cmt_legacy")
	if err != nil || !ok || tok.Profile != "lazy" || !tok.ExpiresAt.IsZero() {
		t.Fatalf("legacy token after migration: %+v ok=%v err=%v", tok, ok, err)
	}
	ups, err := s.ListUpstreams()
	if err != nil || len(ups) != 1 || ups[0].BearerEnv != "K" || ups[0].BearerSecret != "" {
		t.Fatalf("upstreams: %+v %v", ups, err)
	}
	rows, err := s.RecentAudit(5)
	if err != nil || len(rows) != 1 || rows[0].IP != "" || rows[0].Actor != "" {
		t.Fatalf("audit: %+v %v", rows, err)
	}
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v != len(migrations) {
		t.Fatalf("user_version=%d want %d err=%v", v, len(migrations), err)
	}
}

func TestReopenKeepsDataAndDoesNotReapply(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	plain, _, err := s.CreateToken("keep", []string{"x/*"})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer s.Close()
	if _, ok, _ := s.VerifyToken(plain); !ok {
		t.Fatal("token lost across reopen")
	}
}

func TestTokenExpiryAndProfile(t *testing.T) {
	s := openT(t)
	past, _, err := s.CreateTokenOpts("short", []string{"*"}, time.Now().Add(-time.Minute), "lazy")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.VerifyToken(past); ok {
		t.Fatal("an expired token must not verify")
	}
	future, tok, err := s.CreateTokenOpts("long", []string{"*"}, time.Now().Add(time.Hour), "direct:cammut-admin")
	if err != nil {
		t.Fatal(err)
	}
	got, ok, _ := s.VerifyToken(future)
	if !ok || got.Profile != "direct:cammut-admin" || got.ExpiresAt.Unix() != tok.ExpiresAt.Unix() {
		t.Fatalf("future token: %+v ok=%v", got, ok)
	}
	forever, _, _ := s.CreateToken("forever", []string{"*"})
	if g, ok, _ := s.VerifyToken(forever); !ok || !g.ExpiresAt.IsZero() {
		t.Fatalf("no-expiry token: %+v ok=%v", g, ok)
	}
	for _, bad := range []string{"", "Lazy", "direct:", "direct:Bad Name", "other"} {
		if _, _, err := s.CreateTokenOpts("p"+bad, nil, time.Time{}, bad); err == nil {
			t.Fatalf("profile %q must be rejected", bad)
		}
	}
	if tk, ok, err := s.TokenByLabel("long"); err != nil || !ok || tk.Label != "long" {
		t.Fatalf("TokenByLabel: %+v %v %v", tk, ok, err)
	}
	if _, ok, _ := s.TokenByLabel("ghost"); ok {
		t.Fatal("unknown label must report false")
	}
}

func TestUpstreamSecretNameGetAndEnable(t *testing.T) {
	s := openT(t)
	u := Upstream{Name: "gh", URL: "https://api.example.com/mcp", BearerSecret: "GITHUB_PAT", Enabled: true}
	if err := s.AddUpstream(u); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetUpstream("gh")
	if err != nil || !ok || got != u {
		t.Fatalf("get: %+v ok=%v err=%v", got, ok, err)
	}
	if ok, err := s.SetUpstreamEnabled("gh", false); err != nil || !ok {
		t.Fatalf("disable: %v %v", ok, err)
	}
	if got, _, _ := s.GetUpstream("gh"); got.Enabled {
		t.Fatal("still enabled")
	}
	if ok, _ := s.SetUpstreamEnabled("ghost", true); ok {
		t.Fatal("unknown upstream must report false")
	}
	if err := s.AddUpstream(Upstream{Name: "bad", URL: "https://x.example/mcp", BearerSecret: "lower case"}); err == nil {
		t.Fatal("an invalid secret name must be rejected")
	}
}

func TestQueryAuditFilters(t *testing.T) {
	s := openT(t)
	now := time.Now()
	rows := []Audit{
		{TS: now.Add(-3 * time.Hour), TokenID: 1, Upstream: "alpha", Tool: "echo", OK: true, Millis: 1, IP: "1.1.1.1"},
		{TS: now.Add(-2 * time.Hour), TokenID: 2, Upstream: "beta", Tool: "ping", OK: false, Millis: 2, Note: "timeout"},
		{TS: now.Add(-1 * time.Hour), TokenID: 1, Upstream: "admin", Tool: "upstream.add", OK: true, Actor: "user:alice", IP: "2.2.2.2"},
	}
	for _, r := range rows {
		if err := s.AddAudit(r); err != nil {
			t.Fatal(err)
		}
	}
	yes, no := true, false
	cases := []struct {
		name string
		f    AuditFilter
		want int
	}{
		{"all", AuditFilter{}, 3},
		{"token", AuditFilter{TokenID: 1}, 2},
		{"upstream", AuditFilter{Upstream: "beta"}, 1},
		{"tool substring", AuditFilter{Tool: "ping"}, 1},
		{"only failures", AuditFilter{OK: &no}, 1},
		{"only successes", AuditFilter{OK: &yes}, 2},
		{"since", AuditFilter{Since: now.Add(-150 * time.Minute)}, 2},
		{"until", AuditFilter{Until: now.Add(-150 * time.Minute)}, 1},
		{"limit and offset", AuditFilter{Limit: 1, Offset: 1}, 1},
	}
	for _, c := range cases {
		got, err := s.QueryAudit(c.f)
		if err != nil || len(got) != c.want {
			t.Fatalf("%s: got %d rows (want %d) err=%v", c.name, len(got), c.want, err)
		}
	}
	got, _ := s.QueryAudit(AuditFilter{})
	if got[0].Tool != "upstream.add" || got[0].Actor != "user:alice" || got[0].IP != "2.2.2.2" {
		t.Fatalf("newest first with actor and ip: %+v", got[0])
	}
	if big, _ := s.QueryAudit(AuditFilter{Limit: 100000}); len(big) != 3 {
		t.Fatal("limit above the cap must still work")
	}
}

// TestProductionVersion5UpgradesToTheLatest rebuilds a database the way the production binary left it (user_version 5:
// 4 = OAuth tables, 5 = upstreams.auth_header), fills it, and opens it with the current code. Only migrations 6 to 8
// may run, and no row may change.
func TestProductionVersion5UpgradesToTheLatest(t *testing.T) {
	if len(migrations) != 8 {
		t.Fatalf("this test knows 8 migrations, found %d", len(migrations))
	}
	path := filepath.Join(t.TempDir(), "prod.db")
	old, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(schema); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := old.Exec(migrations[i]); err != nil {
			t.Fatalf("migration %d: %v", i+1, err)
		}
	}
	if _, err := old.Exec(`PRAGMA user_version = 5`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO tokens(label,hash,scopes,created_at) VALUES('prod','h1','["a/*"]',1)`,
		`INSERT INTO upstreams(name,url,bearer_env,enabled,created_at,auth_header) VALUES('composio','http://127.0.0.1:1/mcp','',1,1,'x-api-key')`,
		`INSERT INTO secrets(name,nonce,ciphertext,created_at,updated_at) VALUES('K',x'00',x'01',1,2)`,
		`INSERT INTO oauth_clients(id,name,secret_hash,created_at) VALUES('c1','Claude','sh',1)`,
		`INSERT INTO oauth_grants(id,client_id,user_id,scopes,token_label,refresh_hash,created_at) VALUES(1,'c1',1,'[]','oauth-c1','rh',1)`,
		`INSERT INTO mem_projects(name,created_at,last_activity) VALUES('p',1,1)`,
		`INSERT INTO mem_notes(id,project,kind,title,body,source_agent,created_at,updated_at,last_confirmed_at) VALUES('n1','p','finding','t','b','a',1,1,1)`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer s.Close()
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v != 8 {
		t.Fatalf("user_version=%d err=%v, want 8", v, err)
	}
	one := func(q string, dst ...any) {
		t.Helper()
		if err := s.db.QueryRow(q).Scan(dst...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	var purpose, hosts string
	var policySet int
	one(`SELECT purpose, allowed_hosts, policy_set FROM secrets WHERE name='K'`, &purpose, &hosts, &policySet)
	if purpose != "other" || hosts != "[]" || policySet != 0 {
		t.Fatalf("secret after upgrade: %q %q %d", purpose, hosts, policySet)
	}
	var key sql.NullString
	var epi string
	one(`SELECT note_key, epistemic FROM mem_notes WHERE id='n1'`, &key, &epi)
	if key.Valid || epi != "inferred" {
		t.Fatalf("note after upgrade: %v %q", key, epi)
	}
	var hdr, cname string
	one(`SELECT auth_header FROM upstreams WHERE name='composio'`, &hdr)
	one(`SELECT name FROM oauth_clients WHERE id='c1'`, &cname)
	var grants, llm, review int
	one(`SELECT count(*) FROM oauth_grants WHERE refresh_hash='rh'`, &grants)
	one(`SELECT count(*) FROM sqlite_master WHERE name IN ('llm_providers','llm_roles','llm_usage','mem_review','meta')`, &llm)
	one(`SELECT count(*) FROM mem_review`, &review)
	if hdr != "x-api-key" || cname != "Claude" || grants != 1 || llm != 5 || review != 0 {
		t.Fatalf("rows or tables lost: hdr=%q client=%q grants=%d tables=%d", hdr, cname, grants, llm)
	}
	s.Close()
	s2, err := Open(path) // a second open applies nothing
	if err != nil {
		t.Fatal(err)
	}
	s2.Close()
}

// TestVersion7UpgradesToCheckpoints: a v7 database keeps its rows and gains the two checkpoint tables.
func TestVersion7UpgradesToCheckpoints(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v7.db")
	old, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(schema); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 7; i++ {
		if _, err := old.Exec(migrations[i]); err != nil {
			t.Fatalf("migration %d: %v", i+1, err)
		}
	}
	for _, q := range []string{
		`PRAGMA user_version = 7`,
		`INSERT INTO mem_projects(name,created_at,last_activity) VALUES('p',1,1)`,
		`INSERT INTO mem_notes(id,project,kind,title,body,source_agent,created_at,updated_at,last_confirmed_at) VALUES('n1','p','finding','t','b','a',1,1,1)`,
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	old.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer s.Close()
	var v, notes, tables int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v != 8 {
		t.Fatalf("user_version=%d err=%v, want 8", v, err)
	}
	s.db.QueryRow(`SELECT count(*) FROM mem_notes WHERE id='n1'`).Scan(&notes)
	s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name IN ('mem_checkpoints','mem_checkpoint_heads')`).Scan(&tables)
	if notes != 1 || tables != 2 {
		t.Fatalf("notes=%d checkpoint tables=%d", notes, tables)
	}
}
