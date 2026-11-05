package store

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func openT(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestTokenLifecycle(t *testing.T) {
	s := openT(t)
	plain, tok, err := s.CreateToken("codex", []string{"alpha/*", "beta/ping"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(plain, "cmt_") || len(plain) != 4+64 {
		t.Fatalf("unexpected token shape %q", plain)
	}
	got, ok, err := s.VerifyToken(plain)
	if err != nil || !ok || got.ID != tok.ID || !reflect.DeepEqual(got.Scopes, []string{"alpha/*", "beta/ping"}) {
		t.Fatalf("verify: %+v ok=%v err=%v", got, ok, err)
	}
	if _, ok, _ := s.VerifyToken(plain + "x"); ok {
		t.Fatal("a wrong token must not verify")
	}
	if done, err := s.RevokeToken("codex"); err != nil || !done {
		t.Fatalf("revoke: %v %v", done, err)
	}
	if _, ok, _ := s.VerifyToken(plain); ok {
		t.Fatal("a revoked token must stop working immediately")
	}
	if _, _, err := s.CreateToken("codex", nil); err == nil {
		t.Fatal("duplicate labels must be rejected")
	}
}

func TestTokenIsStoredOnlyAsHash(t *testing.T) {
	s := openT(t)
	plain, _, _ := s.CreateToken("a", []string{"*"})
	var hash string
	if err := s.db.QueryRow(`SELECT hash FROM tokens`).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if hash == plain || len(hash) != 64 {
		t.Fatalf("token must be stored hashed, got %q", hash)
	}
}

func TestEmptyScopesRoundTrip(t *testing.T) {
	s := openT(t)
	plain, _, err := s.CreateToken("none", nil)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, _ := s.VerifyToken(plain)
	if !ok || len(got.Scopes) != 0 {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func TestTokenValidation(t *testing.T) {
	s := openT(t)
	if _, _, err := s.CreateToken("bad label", nil); err == nil {
		t.Fatal("spaces in labels must be rejected")
	}
	if _, _, err := s.CreateToken("ok", []string{"al pha"}); err == nil {
		t.Fatal("spaces in scopes must be rejected")
	}
}

func TestValidateUpstream(t *testing.T) {
	cases := []struct {
		name string
		u    Upstream
		ok   bool
	}{
		{"loopback http", Upstream{Name: "hindsight", URL: "http://127.0.0.1:8888/mcp/x/"}, true},
		{"https host", Upstream{Name: "remote", URL: "https://example.com/mcp", BearerEnv: "REMOTE_KEY"}, true},
		{"bad name", Upstream{Name: "Bad Name", URL: "http://127.0.0.1/"}, false},
		{"bad scheme", Upstream{Name: "x", URL: "ftp://example.com"}, false},
		{"no host", Upstream{Name: "x", URL: "http:///path"}, false},
		{"cloud metadata ip", Upstream{Name: "x", URL: "http://169.254.169.254/latest/"}, false},
		{"ipv6 link local", Upstream{Name: "x", URL: "http://[fe80::1]/"}, false},
		{"unspecified", Upstream{Name: "x", URL: "http://0.0.0.0/"}, false},
		{"metadata hostname", Upstream{Name: "x", URL: "http://metadata.google.internal/"}, false},
		{"alibaba metadata", Upstream{Name: "x", URL: "http://100.100.100.200/latest/"}, false},
		{"azure wireserver", Upstream{Name: "x", URL: "http://168.63.129.16/"}, false},
		{"aws ipv6 metadata", Upstream{Name: "x", URL: "http://[fd00:ec2::254]/"}, false},
		{"bad env name", Upstream{Name: "x", URL: "http://127.0.0.1/", BearerEnv: "lower"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateUpstream(c.u)
			if (err == nil) != c.ok {
				t.Fatalf("err=%v want ok=%v", err, c.ok)
			}
		})
	}
}

func TestUpstreamUpsertListRemove(t *testing.T) {
	s := openT(t)
	u := Upstream{Name: "alpha", URL: "http://127.0.0.1:1/mcp", Enabled: true}
	if err := s.AddUpstream(u); err != nil {
		t.Fatal(err)
	}
	u.URL = "http://127.0.0.1:2/mcp"
	if err := s.AddUpstream(u); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListUpstreams()
	if err != nil || len(list) != 1 || list[0].URL != "http://127.0.0.1:2/mcp" || !list[0].Enabled {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	if ok, err := s.RemoveUpstream("alpha"); err != nil || !ok {
		t.Fatalf("remove: %v %v", ok, err)
	}
	if ok, _ := s.RemoveUpstream("alpha"); ok {
		t.Fatal("removing twice must report false")
	}
}

func TestAuditAndPrune(t *testing.T) {
	s := openT(t)
	old := time.Now().Add(-100 * 24 * time.Hour)
	if err := s.AddAudit(Audit{TS: old, TokenID: 1, Upstream: "a", Tool: "t", OK: true, Millis: 5}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddAudit(Audit{TS: time.Now(), TokenID: 1, Upstream: "a", Tool: "t2", OK: false, Millis: 7, Note: "boom"}); err != nil {
		t.Fatal(err)
	}
	n, err := s.PruneAudit(time.Now().Add(-90 * 24 * time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("pruned %d err=%v", n, err)
	}
	rows, err := s.RecentAudit(10)
	if err != nil || len(rows) != 1 || rows[0].Tool != "t2" || rows[0].OK || rows[0].Note != "boom" {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
}

func TestSetScopes(t *testing.T) {
	s := openT(t)
	plain, _, err := s.CreateToken("warp", []string{"alpha/*"})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := s.SetScopes("warp", []string{"alpha/*", "github/*"}); err != nil || !ok {
		t.Fatalf("set: %v %v", ok, err)
	}
	got, ok, _ := s.VerifyToken(plain)
	if !ok || !reflect.DeepEqual(got.Scopes, []string{"alpha/*", "github/*"}) {
		t.Fatalf("scopes after update: %+v ok=%v (the same token string must keep working)", got.Scopes, ok)
	}
	if _, err := s.SetScopes("warp", []string{"bad scope"}); err == nil {
		t.Fatal("invalid scopes must be rejected")
	}
	if ok, _ := s.SetScopes("ghost", []string{"a"}); ok {
		t.Fatal("unknown label must report false")
	}
	s.RevokeToken("warp")
	if ok, _ := s.SetScopes("warp", []string{"a"}); ok {
		t.Fatal("revoked tokens must not be editable")
	}
}
