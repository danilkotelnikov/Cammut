package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"cammut/internal/auth"
	"cammut/internal/store"
	"cammut/internal/vault"
)

func adminDo(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(append([]string{"admin"}, args...), &out)
	return out.String(), err
}

func setup(t *testing.T) (db, key string) {
	t.Helper()
	dir := t.TempDir()
	db, key = filepath.Join(dir, "c.db"), filepath.Join(dir, "vault.key")
	if _, err := adminDo(t, "vault-init", "-key", key); err != nil {
		t.Fatal(err)
	}
	return db, key
}

func withPasswords(t *testing.T, pw ...string) {
	t.Helper()
	old := readPassword
	t.Cleanup(func() { readPassword = old })
	i := 0
	readPassword = func(string) (string, error) {
		v := pw[i%len(pw)]
		i++
		return v, nil
	}
}

func openAuth(t *testing.T, db, key string) (*auth.Auth, *store.Store, *vault.Vault) {
	t.Helper()
	st, err := store.Open(db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	k, err := vault.LoadKey(key)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := vault.New(k, st)
	a, err := auth.New(st, v, auth.NewHasher(2, 1))
	if err != nil {
		t.Fatal(err)
	}
	return a, st, v
}

func TestVaultInitRefusesToOverwrite(t *testing.T) {
	_, key := setup(t)
	if _, err := adminDo(t, "vault-init", "-key", key); err == nil {
		t.Fatal("vault-init must never overwrite an existing key")
	}
}

func TestCreateUserPrintsEnrollmentOnceAndTheAccountWorks(t *testing.T) {
	db, key := setup(t)
	withPasswords(t, "correct horse battery")
	out, err := adminDo(t, "create", "-username", "alice", "-db", db, "-key", key)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`secret:\s+([A-Z2-7]+)`).FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no TOTP secret in output:\n%s", out)
	}
	if !strings.Contains(out, "otpauth://totp/Cammut:alice") || !strings.Contains(out, "\x1b[40m") {
		t.Fatalf("output lacks the URI or the terminal QR:\n%s", out)
	}
	if n := len(regexp.MustCompile(`[A-Z2-9]{5}-[A-Z2-9]{5}`).FindAllString(out, -1)); n != 8 {
		t.Fatalf("want 8 recovery codes, found %d", n)
	}
	if strings.Contains(out, "correct horse battery") {
		t.Fatal("the password must never be echoed")
	}
	a, _, _ := openAuth(t, db, key)
	raw, err := decodeSecret(m[1])
	if err != nil {
		t.Fatal(err)
	}
	th := auth.NewThrottle(time.Now)
	code := auth.TOTPNow(raw, time.Now())
	if _, err := a.Login(th, true, "127.0.0.1", "cli-test", "alice", "correct horse battery", code); err != nil {
		t.Fatalf("the printed secret and the chosen password must log in: %v", err)
	}
}

func TestCreateUserRejectsMismatchAndWeakPasswords(t *testing.T) {
	db, key := setup(t)
	withPasswords(t, "correct horse battery", "another one entirely")
	if _, err := adminDo(t, "create", "-username", "alice", "-db", db, "-key", key); err == nil {
		t.Fatal("two different passwords must be refused")
	}
	withPasswords(t, "short", "short")
	if _, err := adminDo(t, "create", "-username", "alice", "-db", db, "-key", key); err == nil {
		t.Fatal("a short password must be refused")
	}
	if _, err := adminDo(t, "create", "-db", db, "-key", key); err == nil {
		t.Fatal("a missing username must be refused")
	}
}

func TestGeneratedPasswordIsPrintedAndWorks(t *testing.T) {
	db, key := setup(t)
	out, err := adminDo(t, "create", "-username", "alice", "-generate", "-db", db, "-key", key)
	if err != nil {
		t.Fatal(err)
	}
	pw := regexp.MustCompile(`password:\s+(\S+)`).FindStringSubmatch(out)
	m := regexp.MustCompile(`secret:\s+([A-Z2-7]+)`).FindStringSubmatch(out)
	if pw == nil || m == nil || len(pw[1]) < auth.MinPasswordLen {
		t.Fatalf("generated password or secret missing:\n%s", out)
	}
	a, _, _ := openAuth(t, db, key)
	raw, _ := decodeSecret(m[1])
	if _, err := a.Login(auth.NewThrottle(time.Now), true, "127.0.0.1", "t", "alice", pw[1], auth.TOTPNow(raw, time.Now())); err != nil {
		t.Fatalf("generated credentials must log in: %v", err)
	}
}

func TestPasswdAndTotpReset(t *testing.T) {
	db, key := setup(t)
	withPasswords(t, "correct horse battery")
	if _, err := adminDo(t, "create", "-username", "alice", "-db", db, "-key", key); err != nil {
		t.Fatal(err)
	}
	withPasswords(t, "a brand new passphrase", "a brand new passphrase")
	if out, err := adminDo(t, "passwd", "-username", "alice", "-db", db, "-key", key); err != nil || !strings.Contains(out, "password changed") {
		t.Fatalf("passwd: %q %v", out, err)
	}
	out, err := adminDo(t, "totp-reset", "-username", "alice", "-db", db, "-key", key)
	if err != nil || !strings.Contains(out, "otpauth://") {
		t.Fatalf("totp-reset: %q %v", out, err)
	}
	if _, err := adminDo(t, "passwd", "-username", "ghost", "-db", db, "-key", key); err == nil {
		t.Fatal("an unknown user must be an error")
	}
}

func TestGitHubLinkResolvesTheNumericID(t *testing.T) {
	db, key := setup(t)
	withPasswords(t, "correct horse battery")
	adminDo(t, "create", "-username", "alice", "-db", db, "-key", key)
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/users/octocat" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"login": "octocat", "id": 583231})
	}))
	defer gh.Close()
	old := githubAPI
	githubAPI = gh.URL
	defer func() { githubAPI = old }()
	out, err := adminDo(t, "github-link", "-username", "alice", "-login", "octocat", "-db", db, "-key", key)
	if err != nil || !strings.Contains(out, "583231") {
		t.Fatalf("link: %q %v", out, err)
	}
	_, st, _ := openAuth(t, db, key)
	if u, ok, _ := st.UserByGitHubID(583231); !ok || u.Username != "alice" {
		t.Fatal("the numeric id was not stored")
	}
	if _, err := adminDo(t, "github-link", "-username", "alice", "-login", "no-such-user", "-db", db, "-key", key); err == nil {
		t.Fatal("an unknown GitHub login must be an error")
	}
}

func TestSecretCommandsNeverPrintValues(t *testing.T) {
	db, key := setup(t)
	withPasswords(t, "github_pat_SECRETVALUE123")
	out, err := adminDo(t, "secret", "set", "GITHUB_PAT", "-purpose", "mcp-upstream-bearer", "-hosts", "api.githubcopilot.com", "-db", db, "-key", key)
	if err != nil || strings.Contains(out, "SECRETVALUE") {
		t.Fatalf("set: %q %v", out, err)
	}
	_, _, v := openAuth(t, db, key)
	if got, ok, _ := v.Get("GITHUB_PAT"); !ok || got != "github_pat_SECRETVALUE123" {
		t.Fatalf("stored value: %q %v", got, ok)
	}
	out, err = adminDo(t, "secret", "list", "-db", db, "-key", key)
	if err != nil || !strings.Contains(out, "GITHUB_PAT") || strings.Contains(out, "SECRETVALUE") {
		t.Fatalf("list: %q %v", out, err)
	}
	if _, err := adminDo(t, "secret", "set", "lowercase", "-db", db, "-key", key); err == nil {
		t.Fatal("an invalid secret name must be refused")
	}
	if out, err = adminDo(t, "secret", "delete", "GITHUB_PAT", "-db", db, "-key", key); err != nil || !strings.Contains(out, "deleted") {
		t.Fatalf("delete: %q %v", out, err)
	}
	if _, err := adminDo(t, "secret", "delete", "GITHUB_PAT", "-db", db, "-key", key); err == nil {
		t.Fatal("deleting a missing secret must be an error")
	}
}

func TestAdminFailsClosedWithoutAGoodKey(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "c.db")
	withPasswords(t, "correct horse battery")
	if _, err := adminDo(t, "create", "-username", "alice", "-db", db, "-key", filepath.Join(dir, "missing.key")); err == nil {
		t.Fatal("a missing key file must stop account creation")
	}
}

func TestSecretSetNeedsAPolicyAndPolicyChangesNeedTheTypedName(t *testing.T) {
	db, key := setup(t)
	withPasswords(t, "value-one-123456")
	if _, err := adminDo(t, "secret", "set", "NEW_KEY", "-db", db, "-key", key); err == nil {
		t.Fatal("a new secret without -purpose/-hosts must be refused")
	}
	if _, err := adminDo(t, "secret", "set", "NEW_KEY", "-purpose", "llm-provider-key", "-hosts", "api.example.com", "-db", db, "-key", key); err != nil {
		t.Fatal(err)
	}
	if _, err := adminDo(t, "secret", "set", "NEW_KEY", "-db", db, "-key", key); err != nil {
		t.Fatalf("rotating without flags keeps the policy: %v", err)
	}
	old := readLine
	t.Cleanup(func() { readLine = old })
	readLine = func(string) (string, error) { return "WRONG", nil }
	if _, err := adminDo(t, "secret", "policy", "NEW_KEY", "-purpose", "llm-provider-key", "-hosts", "evil.example", "-db", db, "-key", key); err == nil {
		t.Fatal("a wrong confirmation must change nothing")
	}
	_, _, v := openAuth(t, db, key)
	if p, _ := v.Policy("NEW_KEY"); p.Hosts[0] != "api.example.com" {
		t.Fatalf("policy changed without confirmation: %+v", p)
	}
	readLine = func(string) (string, error) { return "NEW_KEY", nil }
	if _, err := adminDo(t, "secret", "policy", "NEW_KEY", "-purpose", "llm-provider-key", "-hosts", "api.other.example", "-db", db, "-key", key); err != nil {
		t.Fatal(err)
	}
	out, _ := adminDo(t, "secret", "list", "-db", db, "-key", key)
	if !strings.Contains(out, "api.other.example") || !strings.Contains(out, "llm-provider-key") || strings.Contains(out, "value-one") {
		t.Fatalf("list: %q", out)
	}
}
