package store

import (
	"bytes"
	"testing"
	"time"
)

func mkUser(t *testing.T, s *Store, name string, macs ...string) int64 {
	t.Helper()
	id, err := s.CreateUser(User{Username: name, PasswordHash: "hash-" + name, TOTPSecret: []byte("sealed")}, macs)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestUserLifecycle(t *testing.T) {
	s := openT(t)
	id := mkUser(t, s, "alice", "m1", "m2")
	u, ok, err := s.UserByName("alice")
	if err != nil || !ok || u.ID != id || u.PasswordHash != "hash-alice" || !bytes.Equal(u.TOTPSecret, []byte("sealed")) || u.TOTPLastStep != 0 {
		t.Fatalf("by name: %+v ok=%v err=%v", u, ok, err)
	}
	if _, ok, _ := s.UserByName("ghost"); ok {
		t.Fatal("unknown user must report false")
	}
	if n, _ := s.CountUsers(); n != 1 {
		t.Fatalf("count=%d", n)
	}
	if _, err := s.CreateUser(User{Username: "alice", PasswordHash: "x", TOTPSecret: []byte("y")}, nil); err == nil {
		t.Fatal("duplicate usernames must be rejected")
	}
	if err := s.SetGitHubID(id, 4242); err != nil {
		t.Fatal(err)
	}
	if g, ok, _ := s.UserByGitHubID(4242); !ok || g.ID != id {
		t.Fatalf("by github id: %+v ok=%v", g, ok)
	}
	if _, ok, _ := s.UserByGitHubID(1); ok {
		t.Fatal("unknown github id must report false")
	}
	if byID, ok, _ := s.UserByID(id); !ok || byID.Username != "alice" {
		t.Fatalf("by id: %+v", byID)
	}
}

func newSession(h string, now time.Time) NewSession {
	return NewSession{IDHash: h, Now: now, ExpiresAt: now.Add(time.Hour), IP: "1.2.3.4", UAHash: "ua"}
}

func TestCompleteLoginRejectsReplayAndOlderSteps(t *testing.T) {
	s := openT(t)
	id := mkUser(t, s, "a")
	now := time.Now()
	if ok, err := s.CompleteLogin(id, LoginProof{Step: 100}, newSession("s1", now)); err != nil || !ok {
		t.Fatalf("first use of step 100: %v %v", ok, err)
	}
	if ok, _ := s.CompleteLogin(id, LoginProof{Step: 100}, newSession("s2", now)); ok {
		t.Fatal("the same step must not log in twice")
	}
	if ok, _ := s.CompleteLogin(id, LoginProof{Step: 99}, newSession("s3", now)); ok {
		t.Fatal("an older step must not log in")
	}
	if ok, _ := s.CompleteLogin(id, LoginProof{Step: 101}, newSession("s4", now)); !ok {
		t.Fatal("a newer step must log in")
	}
	if _, ok, _ := s.SessionByHash("s2"); ok {
		t.Fatal("a rejected login must not leave a session behind")
	}
	if u, _, _ := s.UserByID(id); u.TOTPLastStep != 101 {
		t.Fatalf("last step=%d", u.TOTPLastStep)
	}
}

func TestRecoveryCodeIsSingleUse(t *testing.T) {
	s := openT(t)
	id := mkUser(t, s, "a", "mac-1", "mac-2")
	now := time.Now()
	if ok, _ := s.CompleteLogin(id, LoginProof{RecoveryMAC: "mac-1"}, newSession("r1", now)); !ok {
		t.Fatal("a valid recovery code must log in")
	}
	if ok, _ := s.CompleteLogin(id, LoginProof{RecoveryMAC: "mac-1"}, newSession("r2", now)); ok {
		t.Fatal("a recovery code must work once")
	}
	if ok, _ := s.CompleteLogin(id, LoginProof{RecoveryMAC: "nope"}, newSession("r3", now)); ok {
		t.Fatal("an unknown recovery code must fail")
	}
	other := mkUser(t, s, "b", "mac-9")
	if ok, _ := s.CompleteLogin(other, LoginProof{RecoveryMAC: "mac-2"}, newSession("r4", now)); ok {
		t.Fatal("a recovery code must belong to the user")
	}
}

func TestConcurrentLoginsWithOneStepYieldOneSession(t *testing.T) {
	s := openT(t)
	id := mkUser(t, s, "a")
	now := time.Now()
	results := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		go func(i int) {
			ok, _ := s.CompleteLogin(id, LoginProof{Step: 7}, newSession(string(rune('a'+i)), now))
			results <- ok
		}(i)
	}
	wins := 0
	for i := 0; i < 8; i++ {
		if <-results {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("%d concurrent logins succeeded with one TOTP step; want exactly 1", wins)
	}
}

func TestSessionLifecycleAndInvalidation(t *testing.T) {
	s := openT(t)
	id := mkUser(t, s, "a")
	now := time.Unix(1_700_000_000, 0)
	if ok, _ := s.CompleteLogin(id, LoginProof{Step: 1}, newSession("h1", now)); !ok {
		t.Fatal("login")
	}
	info, ok, err := s.SessionByHash("h1")
	if err != nil || !ok || info.UserID != id || !info.CreatedAt.Equal(now) || !info.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("session: %+v ok=%v err=%v", info, ok, err)
	}
	later := now.Add(10 * time.Minute)
	if err := s.TouchSession("h1", later, later.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if info, _, _ := s.SessionByHash("h1"); !info.LastSeen.Equal(later) || !info.ExpiresAt.Equal(later.Add(time.Hour)) {
		t.Fatalf("after touch: %+v", info)
	}
	if err := s.DeleteSession("h1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionByHash("h1"); ok {
		t.Fatal("deleted session still found")
	}
	s.CompleteLogin(id, LoginProof{Step: 2}, newSession("h2", now))
	s.CompleteLogin(id, LoginProof{Step: 3}, newSession("h3", now))
	if err := s.SetPasswordHash(id, "new-hash"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionByHash("h2"); ok {
		t.Fatal("a password change must end every session")
	}
	s.CompleteLogin(id, LoginProof{Step: 4}, newSession("h4", now))
	if err := s.ReplaceTOTP(id, []byte("new-sealed"), []string{"x1"}); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionByHash("h4"); ok {
		t.Fatal("a TOTP reset must end every session")
	}
	u, _, _ := s.UserByID(id)
	if u.PasswordHash != "new-hash" || !bytes.Equal(u.TOTPSecret, []byte("new-sealed")) || u.TOTPLastStep != 0 {
		t.Fatalf("user after changes: %+v", u)
	}
	s.CompleteLogin(id, LoginProof{Step: 5}, NewSession{IDHash: "old", Now: now, ExpiresAt: now.Add(time.Minute)})
	if n, err := s.PruneSessions(now.Add(time.Hour)); err != nil || n != 1 {
		t.Fatalf("prune: %d %v", n, err)
	}
}

func TestPendingLoginsAndOAuthStates(t *testing.T) {
	s := openT(t)
	id := mkUser(t, s, "a")
	now := time.Now()
	if err := s.PutPending("p1", id, now.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got, ok, _ := s.PendingUser("p1", now); !ok || got != id {
		t.Fatalf("pending: %d %v", got, ok)
	}
	if _, ok, _ := s.PendingUser("p1", now.Add(6*time.Minute)); ok {
		t.Fatal("an expired pending login must not be found")
	}
	if err := s.DeletePending("p1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.PendingUser("p1", now); ok {
		t.Fatal("deleted pending login still found")
	}

	if err := s.PutOAuthState("st", "verifier-1", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := s.TakeOAuthState("st", now); !ok || v != "verifier-1" {
		t.Fatalf("take: %q %v", v, ok)
	}
	if _, ok, _ := s.TakeOAuthState("st", now); ok {
		t.Fatal("an OAuth state must be single use")
	}
	s.PutOAuthState("old", "v", now.Add(-time.Second))
	if _, ok, _ := s.TakeOAuthState("old", now); ok {
		t.Fatal("an expired OAuth state must be refused")
	}
}

func TestSecretsStore(t *testing.T) {
	s := openT(t)
	now := time.Unix(1_700_000_000, 0)
	if err := s.PutSecret("GITHUB_PAT", []byte("n1"), []byte("c1"), now); err != nil {
		t.Fatal(err)
	}
	n, c, ok, err := s.GetSecret("GITHUB_PAT")
	if err != nil || !ok || string(n) != "n1" || string(c) != "c1" {
		t.Fatalf("get: %q %q %v %v", n, c, ok, err)
	}
	if err := s.PutSecret("GITHUB_PAT", []byte("n2"), []byte("c2"), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n, _, _, _ := s.GetSecret("GITHUB_PAT"); string(n) != "n2" {
		t.Fatal("put must replace")
	}
	meta, err := s.ListSecretMeta()
	if err != nil || len(meta) != 1 || meta[0].Name != "GITHUB_PAT" || !meta[0].UpdatedAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("meta: %+v %v", meta, err)
	}
	if _, _, ok, _ := s.GetSecret("NOPE"); ok {
		t.Fatal("unknown secret must report false")
	}
	if ok, _ := s.DeleteSecret("GITHUB_PAT"); !ok {
		t.Fatal("delete")
	}
	if ok, _ := s.DeleteSecret("GITHUB_PAT"); ok {
		t.Fatal("second delete must report false")
	}
}
