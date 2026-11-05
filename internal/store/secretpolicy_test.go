package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestBackfillDerivesPoliciesOnceAndQuarantinesMixedUse(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	for _, n := range []string{"GH_PAT", "SHARED", "PROV_KEY", "STRAY", "GITHUB_OAUTH_CLIENT_ID"} {
		if err := s.PutSecret(n, []byte("n"), []byte("c"), now); err != nil {
			t.Fatal(err)
		}
	}
	s.AddUpstream(Upstream{Name: "gh", URL: "https://api.githubcopilot.com/mcp/", BearerSecret: "GH_PAT", Enabled: true})
	s.AddUpstream(Upstream{Name: "a", URL: "https://a.example.com/mcp", BearerSecret: "SHARED", Enabled: true})
	s.AddUpstream(Upstream{Name: "b", URL: "https://b.example.com/mcp", BearerSecret: "SHARED", Enabled: true})
	if _, err := s.db.Exec(`INSERT INTO llm_providers(id,label,kind,base_url,secret_name,created_at) VALUES('p','P','openai','https://api.p.example/v1','PROV_KEY',1),('q','Q','openai','https://api.q.example/v1','SHARED',1)`); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSecretPolicy("EXPLICIT", []byte("n"), []byte("c"), "llm-provider-key", []string{"keep.example.com"}, now); err != nil {
		t.Fatal(err)
	}
	res, err := s.BackfillSecretPolicies()
	if err != nil || !res.Ran {
		t.Fatalf("%+v %v", res, err)
	}
	check := func(name, wantPurpose string, wantHosts ...string) {
		t.Helper()
		p, h, set, ok, err := s.SecretPolicy(name)
		if err != nil || !ok || !set || p != wantPurpose || len(h) != len(wantHosts) {
			t.Fatalf("%s: %s %v set=%v ok=%v %v", name, p, h, set, ok, err)
		}
		for i := range h {
			if h[i] != wantHosts[i] {
				t.Fatalf("%s: hosts %v want %v", name, h, wantHosts)
			}
		}
	}
	check("GH_PAT", "mcp-upstream-bearer", "api.githubcopilot.com")
	check("PROV_KEY", "llm-provider-key", "api.p.example")
	check("SHARED", "other") // mcp bearer AND provider key: quarantined
	check("STRAY", "other")
	check("GITHUB_OAUTH_CLIENT_ID", "oauth-client", "github.com")
	check("EXPLICIT", "llm-provider-key", "keep.example.com") // an explicit policy is preserved
	if len(res.Quarantined) != 1 || res.Quarantined[0] != "SHARED" {
		t.Fatalf("quarantined: %v", res.Quarantined)
	}
	// finished backfills never run again: a later explicit change survives a restart
	if ok, err := s.SetSecretPolicy("GH_PAT", "mcp-upstream-bearer", []string{"x.example.com"}); err != nil || !ok {
		t.Fatal(err)
	}
	if res2, err := s.BackfillSecretPolicies(); err != nil || res2.Ran {
		t.Fatalf("second run: %+v %v", res2, err)
	}
	check("GH_PAT", "mcp-upstream-bearer", "x.example.com")
}
