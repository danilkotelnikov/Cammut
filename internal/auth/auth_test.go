package auth

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cammut/internal/store"
	"cammut/internal/vault"
)

const goodPassword = "correct horse battery"

type env struct {
	a      *Auth
	st     *store.Store
	clock  time.Time
	enr    Enrollment
	secret []byte
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	v, err := vault.New(bytes.Repeat([]byte{3}, vault.KeySize), st)
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(st, v, NewHasher(2, 1))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{a: a, st: st, clock: time.Unix(1_800_000_000, 0)}
	a.Now = func() time.Time { return e.clock }
	e.enr, err = a.CreateUser("alice", goodPassword)
	if err != nil {
		t.Fatal(err)
	}
	e.secret, err = b32.DecodeString(e.enr.Secret)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) code() string { return totpAt(e.secret, e.clock.Unix()/30) }

func (e *env) login(th *Throttle, user, pw, code string) (string, error) {
	return e.a.Login(th, false, "9.9.9.9", "ua", user, pw, code)
}

func TestCreateUserEnrollmentAndStorage(t *testing.T) {
	e := newEnv(t)
	if !strings.HasPrefix(e.enr.URI, "otpauth://totp/Cammut:alice?") || len(e.enr.RecoveryCodes) != 8 {
		t.Fatalf("enrollment: %+v", e.enr)
	}
	u, ok, _ := e.st.UserByName("alice")
	if !ok || strings.Contains(u.PasswordHash, goodPassword) || bytes.Contains(u.TOTPSecret, e.secret) {
		t.Fatal("password or TOTP secret stored in clear")
	}
	for _, bad := range []string{"", "ab", "Alice", "1abc", "has space", strings.Repeat("a", 40)} {
		if _, err := e.a.CreateUser(bad, goodPassword); err == nil {
			t.Fatalf("username %q must be rejected", bad)
		}
	}
	if _, err := e.a.CreateUser("short", "tooshort"); err == nil {
		t.Fatal("a short password must be rejected")
	}
	if _, err := e.a.CreateUser("alice", goodPassword); err == nil {
		t.Fatal("a duplicate username must be rejected")
	}
}

func TestLoginSessionAndLogout(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	tok, err := e.login(th, "alice", goodPassword, e.code())
	if err != nil || tok == "" {
		t.Fatalf("login: %q %v", tok, err)
	}
	u, ok := e.a.Session(tok)
	if !ok || u.Username != "alice" {
		t.Fatalf("session: %+v %v", u, ok)
	}
	if _, ok := e.a.Session(tok + "x"); ok {
		t.Fatal("a wrong token must not resolve")
	}
	if _, ok := e.a.Session(""); ok {
		t.Fatal("an empty token must not resolve")
	}
	e.a.Logout(tok)
	if _, ok := e.a.Session(tok); ok {
		t.Fatal("logout must end the session")
	}
}

func TestAllFailuresLookTheSame(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	cases := []struct{ name, user, pw, code string }{
		{"unknown user", "nobody", goodPassword, e.code()},
		{"wrong password", "alice", goodPassword + "x", e.code()},
		{"wrong code", "alice", goodPassword, "000000"},
		{"short code", "alice", goodPassword, "12345"},
		{"letters as code", "alice", goodPassword, "abcdef"},
		{"empty code", "alice", goodPassword, ""},
		{"huge password", "alice", strings.Repeat("a", 5000), e.code()},
		{"huge code", "alice", goodPassword, strings.Repeat("1", 5000)},
		{"huge username", strings.Repeat("a", 5000), goodPassword, e.code()},
	}
	for i, c := range cases {
		th.Clear("9.9.9.9") // isolate the cases from the throttle
		tok, err := e.login(th, c.user, c.pw, c.code)
		if tok != "" || !errors.Is(err, ErrInvalid) {
			t.Fatalf("%d %s: token=%q err=%v, want ErrInvalid", i, c.name, tok, err)
		}
	}
}

func TestTOTPCodeWorksOnceAndWindowIsEnforced(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	code := e.code()
	if _, err := e.login(th, "alice", goodPassword, code); err != nil {
		t.Fatal(err)
	}
	if _, err := e.login(th, "alice", goodPassword, code); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a code must not log in twice, got %v", err)
	}
	e.clock = e.clock.Add(30 * time.Second)
	if _, err := e.login(th, "alice", goodPassword, e.code()); err != nil {
		t.Fatalf("the next step's code must work: %v", err)
	}
	// a code two steps old is outside the window
	e.clock = e.clock.Add(120 * time.Second)
	old := totpAt(e.secret, e.clock.Unix()/30-2)
	if _, err := e.login(th, "alice", goodPassword, old); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a code two steps old must fail, got %v", err)
	}
}

func TestConcurrentLoginsWithOneCodeMakeOneSession(t *testing.T) {
	e := newEnv(t)
	code := e.code()
	results := make(chan error, 6)
	for i := 0; i < 6; i++ {
		go func() {
			th := NewThrottle(func() time.Time { return e.clock })
			_, err := e.a.Login(th, false, "9.9.9.9", "ua", "alice", goodPassword, code)
			results <- err
		}()
	}
	wins := 0
	for i := 0; i < 6; i++ {
		err := <-results
		if err == nil {
			wins++
		} else if !errors.Is(err, ErrInvalid) && !errors.Is(err, ErrBusy) {
			t.Fatalf("unexpected error %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("%d logins succeeded with one code, want exactly 1", wins)
	}
}

func TestRecoveryCodeWorksOnceInAnyCaseOrSpacing(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	rc := e.enr.RecoveryCodes[0]
	typed := strings.ToLower(strings.ReplaceAll(rc, "-", " "))
	if _, err := e.login(th, "alice", goodPassword, typed); err != nil {
		t.Fatalf("recovery code %q: %v", typed, err)
	}
	if _, err := e.login(th, "alice", goodPassword, rc); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a recovery code must work once, got %v", err)
	}
	if _, err := e.login(th, "alice", goodPassword, "AAAAA-BBBBB"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an unknown recovery code must fail, got %v", err)
	}
	if _, err := e.login(th, "alice", "wrong password here", e.enr.RecoveryCodes[1]); !errors.Is(err, ErrInvalid) {
		t.Fatal("a right recovery code with a wrong password must fail")
	}
}

func TestThrottleBlocksOneIPOnlyAndBlockedAttemptsAreNotCounted(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	for i := 0; i < 5; i++ {
		if _, err := e.a.Login(th, false, "7.7.7.7", "ua", "alice", "wrong password here", "000000"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	var be *BlockedError
	_, err := e.a.Login(th, false, "7.7.7.7", "ua", "alice", goodPassword, e.code())
	if !errors.As(err, &be) || be.RetryAfter != time.Minute {
		t.Fatalf("sixth attempt must be blocked even with right credentials: %v", err)
	}
	if _, err := e.a.Login(th, false, "8.8.8.8", "ua", "alice", goodPassword, e.code()); err != nil {
		t.Fatalf("another address must still log in: %v", err)
	}
	e.clock = e.clock.Add(61 * time.Second)
	if _, err := e.a.Login(th, false, "7.7.7.7", "ua", "alice", goodPassword, e.code()); err != nil {
		t.Fatalf("after the block the address works again: %v", err)
	}
}

func TestBusyHasherIsNotAFailedAttempt(t *testing.T) {
	e := newEnv(t)
	e.a.h = NewHasher(0, 0)
	th := NewThrottle(func() time.Time { return e.clock })
	for i := 0; i < 20; i++ {
		if _, err := e.login(th, "alice", goodPassword, e.code()); !errors.Is(err, ErrBusy) {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if _, ok := th.Check("9.9.9.9"); !ok {
		t.Fatal("being busy must not count against the client")
	}
}

func TestSessionIdleAndAbsoluteExpiryAndTouch(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	tok, err := e.login(th, "alice", goodPassword, e.code())
	if err != nil {
		t.Fatal(err)
	}
	e.clock = e.clock.Add(11 * time.Hour)
	if _, ok := e.a.Session(tok); !ok {
		t.Fatal("still inside the idle window")
	}
	e.clock = e.clock.Add(11 * time.Hour) // 22 h after login; the touch at 11 h moved idle expiry to 23 h
	if _, ok := e.a.Session(tok); !ok {
		t.Fatal("activity must extend the idle window")
	}
	e.clock = e.clock.Add(13 * time.Hour) // 35 h, 13 h idle
	if _, ok := e.a.Session(tok); ok {
		t.Fatal("an idle session must expire")
	}

	e2 := newEnv(t)
	e2.a.Abs = time.Hour
	th2 := NewThrottle(func() time.Time { return e2.clock })
	tok2, _ := e2.login(th2, "alice", goodPassword, e2.code())
	e2.clock = e2.clock.Add(30 * time.Minute)
	if _, ok := e2.a.Session(tok2); !ok {
		t.Fatal("inside the absolute lifetime")
	}
	e2.clock = e2.clock.Add(31 * time.Minute)
	if _, ok := e2.a.Session(tok2); ok {
		t.Fatal("the absolute lifetime must end the session even when active")
	}
}

func TestPasswordChangeAndTOTPResetEndSessionsAndSwapCredentials(t *testing.T) {
	e := newEnv(t)
	th := NewThrottle(func() time.Time { return e.clock })
	tok, _ := e.login(th, "alice", goodPassword, e.code())
	if err := e.a.SetPassword("alice", "an entirely new password"); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.a.Session(tok); ok {
		t.Fatal("a password change must end sessions")
	}
	e.clock = e.clock.Add(30 * time.Second)
	if _, err := e.login(th, "alice", goodPassword, e.code()); !errors.Is(err, ErrInvalid) {
		t.Fatal("the old password must stop working")
	}
	th.Clear("9.9.9.9")
	tok, err := e.login(th, "alice", "an entirely new password", e.code())
	if err != nil {
		t.Fatalf("the new password must work: %v", err)
	}

	oldSecret, oldCodes := e.secret, e.enr.RecoveryCodes
	enr, err := e.a.ResetTOTP("alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := e.a.Session(tok); ok {
		t.Fatal("a TOTP reset must end sessions")
	}
	e.clock = e.clock.Add(30 * time.Second)
	if _, err := e.login(th, "alice", "an entirely new password", totpAt(oldSecret, e.clock.Unix()/30)); !errors.Is(err, ErrInvalid) {
		t.Fatal("the old authenticator must stop working")
	}
	if _, err := e.login(th, "alice", "an entirely new password", oldCodes[2]); !errors.Is(err, ErrInvalid) {
		t.Fatal("old recovery codes must stop working")
	}
	e.secret, _ = b32.DecodeString(enr.Secret)
	if _, err := e.login(th, "alice", "an entirely new password", e.code()); err != nil {
		t.Fatalf("the new authenticator must work: %v", err)
	}
	if err := e.a.SetPassword("ghost", goodPassword); err == nil {
		t.Fatal("an unknown user must be an error")
	}
	if _, err := e.a.ResetTOTP("ghost"); err == nil {
		t.Fatal("an unknown user must be an error")
	}
	if err := e.a.LinkGitHub("alice", 4242); err != nil {
		t.Fatal(err)
	}
	if u, ok, _ := e.st.UserByGitHubID(4242); !ok || u.Username != "alice" {
		t.Fatal("github link not stored")
	}
	if err := e.a.LinkGitHub("ghost", 1); err == nil {
		t.Fatal("an unknown user must be an error")
	}
}
