package service

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
	"cammut/internal/upstream"
	"cammut/internal/vault"
)

var alice = Actor{Kind: "user", Name: "alice", IP: "198.51.100.7"}

func newSvc(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	v, err := vault.New(bytes.Repeat([]byte{5}, vault.KeySize), st)
	if err != nil {
		t.Fatal(err)
	}
	mgr := upstream.NewManager(func(string) string { return "" })
	return New(st, mgr, v, func(string) string { return "" }), st
}

func echoTool() fakemcp.Tool {
	return fakemcp.Tool{Name: "echo", Description: "Echo", Run: func(map[string]any) string { return "x" }}
}

func find(views []UpstreamView, name string) *UpstreamView {
	for i := range views {
		if views[i].Name == name {
			return &views[i]
		}
	}
	return nil
}

func TestUpstreamLifecycle(t *testing.T) {
	s, st := newSvc(t)
	ts := fakemcp.New(t, "", echoTool())
	ctx := context.Background()
	if err := s.UpstreamAdd(alice, store.Upstream{Name: "alpha", URL: ts.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	views, err := s.Upstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	v := find(views, "alpha")
	if v == nil || v.Status != "ok" || v.Tools != 1 || !v.Enabled {
		t.Fatalf("view: %+v", v)
	}
	if err := s.UpstreamAdd(alice, store.Upstream{Name: "alpha", URL: ts.URL, Enabled: true}); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate: %v", err)
	}
	for _, bad := range []store.Upstream{
		{Name: "Bad Name", URL: ts.URL},
		{Name: "evil", URL: "http://169.254.169.254/"},
		{Name: "nourl", URL: ""},
		{Name: "x", URL: ts.URL, BearerSecret: "lower"},
	} {
		if err := s.UpstreamAdd(alice, bad); !errors.Is(err, ErrBadInput) {
			t.Fatalf("%+v: want ErrBadInput, got %v", bad, err)
		}
	}
	off := false
	if err := s.UpstreamUpdate(alice, "alpha", UpstreamPatch{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	views, _ = s.Upstreams(ctx)
	if v := find(views, "alpha"); v == nil || v.Status != "disabled" {
		t.Fatalf("disabled view: %+v", v)
	}
	on := true
	if err := s.UpstreamUpdate(alice, "alpha", UpstreamPatch{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpstreamUpdate(alice, "ghost", UpstreamPatch{Enabled: &on}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update ghost: %v", err)
	}
	badURL := "http://169.254.169.254/"
	if err := s.UpstreamUpdate(alice, "alpha", UpstreamPatch{URL: &badURL}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("update to a metadata url: %v", err)
	}
	if err := s.UpstreamRemove(alice, "alpha"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpstreamRemove(alice, "alpha"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second remove: %v", err)
	}
	if ups, _ := st.ListUpstreams(); len(ups) != 0 {
		t.Fatal("upstream still stored")
	}
	rows, _ := s.AuditQuery(store.AuditFilter{Upstream: "admin"})
	var tools []string
	for _, r := range rows {
		if r.Actor != "user:alice" || r.IP != "198.51.100.7" {
			t.Fatalf("admin audit row without actor or ip: %+v", r)
		}
		tools = append(tools, r.Tool)
	}
	for _, want := range []string{"upstream.add", "upstream.update", "upstream.remove"} {
		if !strings.Contains(strings.Join(tools, ","), want) {
			t.Fatalf("audit lacks %s: %v", want, tools)
		}
	}
}

func TestUpstreamTestAndVaultBackedBearer(t *testing.T) {
	s, _ := newSvc(t)
	ts := fakemcp.New(t, "tok123", echoTool())
	ctx := context.Background()
	if err := s.UpstreamAdd(alice, store.Upstream{Name: "gh", URL: ts.URL, BearerSecret: "GH_PAT", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	views, _ := s.Upstreams(ctx)
	if v := find(views, "gh"); v == nil || v.SecretSet || v.Status == "ok" {
		t.Fatalf("before the secret exists the upstream must not look healthy or have a secret: %+v", v)
	}
	res, err := s.UpstreamTest(ctx, alice, "gh")
	if err != nil || res.OK || res.Error == "" {
		t.Fatalf("test without the secret must fail cleanly: %+v %v", res, err)
	}
	if err := s.SecretPut(alice, "GH_PAT", "tok123", loopbackBearer); err != nil {
		t.Fatal(err)
	}
	res, err = s.UpstreamTest(ctx, alice, "gh")
	if err != nil || !res.OK || len(res.Tools) != 1 || res.Tools[0] != "echo" {
		t.Fatalf("test after the secret: %+v %v", res, err)
	}
	if _, err := s.UpstreamTest(ctx, alice, "ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("test ghost: %v", err)
	}
	off := false
	s.UpstreamUpdate(alice, "gh", UpstreamPatch{Enabled: &off})
	if res, err := s.UpstreamTest(ctx, alice, "gh"); err != nil || res.OK {
		t.Fatalf("a disabled upstream is reported, not an error: %+v %v", res, err)
	}
}

func TestSecretsNeverComeBack(t *testing.T) {
	s, st := newSvc(t)
	if err := s.SecretPut(alice, "GH_PAT", "github_pat_VALUE", loopbackBearer); err != nil {
		t.Fatal(err)
	}
	meta, err := s.Secrets()
	if err != nil || len(meta) != 1 || meta[0].Name != "GH_PAT" {
		t.Fatalf("meta: %+v %v", meta, err)
	}
	rows, _ := st.QueryAudit(store.AuditFilter{})
	for _, r := range rows {
		if strings.Contains(r.Note, "VALUE") || strings.Contains(r.Tool, "VALUE") {
			t.Fatalf("a secret value leaked into the audit log: %+v", r)
		}
	}
	for _, bad := range [][2]string{{"lower", "x"}, {"GH_PAT", ""}, {"GH_PAT", "has\nnewline"}, {"GH_PAT", " lead"}} {
		if err := s.SecretPut(alice, bad[0], bad[1], loopbackBearer); !errors.Is(err, ErrBadInput) {
			t.Fatalf("%q/%q: want ErrBadInput, got %v", bad[0], bad[1], err)
		}
	}
	if err := s.SecretDelete(alice, "GH_PAT"); err != nil {
		t.Fatal(err)
	}
	if err := s.SecretDelete(alice, "GH_PAT"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestTokens(t *testing.T) {
	s, st := newSvc(t)
	plain, tok, err := s.TokenCreate(alice, TokenCreate{Label: "warp", Scopes: []string{"github/*"}, Expires: 24 * time.Hour})
	if err != nil || !strings.HasPrefix(plain, "cmt_") || tok.ExpiresAt.IsZero() || tok.Profile != "lazy" {
		t.Fatalf("create: %q %+v %v", plain, tok, err)
	}
	if got, ok, _ := st.VerifyToken(plain); !ok || got.Label != "warp" {
		t.Fatal("the new token must verify")
	}
	if _, _, err := s.TokenCreate(alice, TokenCreate{Label: "warp"}); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate label: %v", err)
	}
	for _, bad := range []TokenCreate{
		{Label: "bad label"}, {Label: "x", Scopes: []string{"bad scope"}}, {Label: "y", Expires: 400 * 24 * time.Hour}, {Label: "z", Expires: -time.Hour},
	} {
		if _, _, err := s.TokenCreate(alice, bad); !errors.Is(err, ErrBadInput) {
			t.Fatalf("%+v: want ErrBadInput, got %v", bad, err)
		}
	}
	if err := s.TokenSetScopes(alice, "warp", []string{"github/*", "hindsight/*"}); err != nil {
		t.Fatal(err)
	}
	if got, ok, _ := s.Token("warp"); !ok || len(got.Scopes) != 2 {
		t.Fatalf("scopes: %+v", got)
	}
	if err := s.TokenSetScopes(alice, "warp", []string{"bad scope"}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("bad scope: %v", err)
	}
	if err := s.TokenSetScopes(alice, "ghost", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("scopes ghost: %v", err)
	}
	if err := s.TokenRevoke(alice, "warp"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.VerifyToken(plain); ok {
		t.Fatal("a revoked token must stop working")
	}
	if err := s.TokenRevoke(alice, "warp"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second revoke: %v", err)
	}
	list, _ := s.Tokens()
	if len(list) != 1 || !list[0].Revoked {
		t.Fatalf("list: %+v", list)
	}
}

var loopbackBearer = &vault.Policy{Purpose: vault.PurposeMCPBearer, Hosts: []string{"127.0.0.1"}}

func TestSecretPolicyIsMandatoryAtCreationAndChangesOnlyWithTheTypedName(t *testing.T) {
	s, st := newSvc(t)
	if err := s.SecretPut(alice, "NEW_KEY", "v1", nil); !errors.Is(err, ErrBadInput) {
		t.Fatalf("a new secret without a policy: %v", err)
	}
	if err := s.SecretPut(alice, "NEW_KEY", "v1", loopbackBearer); err != nil {
		t.Fatal(err)
	}
	if err := s.SecretPut(alice, "NEW_KEY", "v2", nil); err != nil {
		t.Fatalf("rotation keeps the policy: %v", err)
	}
	other := &vault.Policy{Purpose: vault.PurposeLLMKey, Hosts: []string{"api.example.com"}}
	if err := s.SecretPut(alice, "NEW_KEY", "v3", other); !errors.Is(err, ErrBadInput) {
		t.Fatalf("a put must not change the policy: %v", err)
	}
	if err := s.SecretSetPolicy(alice, "NEW_KEY", *other, "WRONG"); !errors.Is(err, ErrBadInput) {
		t.Fatalf("confirmation must be the exact name: %v", err)
	}
	assistant := Actor{Kind: "assistant", Name: "agent"}
	if err := s.SecretSetPolicy(assistant, "NEW_KEY", *other, "NEW_KEY"); !errors.Is(err, ErrBadInput) {
		t.Fatalf("an assistant can never change a policy: %v", err)
	}
	if err := s.SecretSetPolicy(alice, "GHOST", *other, "GHOST"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ghost: %v", err)
	}
	if err := s.SecretSetPolicy(alice, "NEW_KEY", *other, "NEW_KEY"); err != nil {
		t.Fatal(err)
	}
	meta, _ := s.Secrets()
	if len(meta) != 1 || meta[0].Purpose != vault.PurposeLLMKey || len(meta[0].Hosts) != 1 || meta[0].Hosts[0] != "api.example.com" {
		t.Fatalf("%+v", meta)
	}
	rows, _ := st.QueryAudit(store.AuditFilter{})
	found := false
	for _, r := range rows {
		if r.Tool == "secret.policy" && r.OK {
			found = strings.Contains(r.Note, "NEW_KEY") && strings.Contains(r.Note, "api.example.com")
		}
		if strings.Contains(r.Note, "v1") && strings.Contains(r.Tool, "secret") && !strings.Contains(r.Note, "NEW_KEY") {
			t.Fatalf("value-like text in audit: %+v", r)
		}
	}
	if !found {
		t.Fatalf("secret.policy must be audited with purpose and hosts: %+v", rows)
	}
}
