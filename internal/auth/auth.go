package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"cammut/internal/store"
	"cammut/internal/vault"
)

var (
	// ErrInvalid is the single answer for every kind of failed login.
	ErrInvalid = errors.New("invalid credentials")

	usernameRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{2,31}$`)
	totpAAD    = []byte("cammut/totp")
)

// BlockedError means the client address is in a backoff period.
type BlockedError struct{ RetryAfter time.Duration }

func (e *BlockedError) Error() string { return "too many attempts" }

// Enrollment is what the admin sees once when an account or its authenticator is created.
type Enrollment struct {
	URI           string
	Secret        string
	RecoveryCodes []string
}

type Auth struct {
	st    *store.Store
	v     *vault.Vault
	h     *Hasher
	dummy string

	Now  func() time.Time
	Idle time.Duration
	Abs  time.Duration
}

func New(st *store.Store, v *vault.Vault, h *Hasher) (*Auth, error) {
	dummy, err := HashPassword("dummy password for timing parity")
	if err != nil {
		return nil, err
	}
	return &Auth{st: st, v: v, h: h, dummy: dummy, Now: time.Now, Idle: 12 * time.Hour, Abs: 7 * 24 * time.Hour}, nil
}

func newSessionToken() (token, hash string) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, store.HashToken(token)
}

func (a *Auth) expiry(now, created time.Time) time.Time {
	e := now.Add(a.Idle)
	if abs := created.Add(a.Abs); abs.Before(e) {
		e = abs
	}
	return e
}

func (a *Auth) recoveryMACs(codes []string) []string {
	out := make([]string, len(codes))
	for i, c := range codes {
		out[i] = a.v.MAC("recovery", []byte(NormalizeRecovery(c)))
	}
	return out
}

func (a *Auth) enroll(account string) (secret []byte, sealed []byte, codes []string, enr Enrollment) {
	secret = GenerateTOTPSecret()
	codes = GenerateRecoveryCodes(8)
	sealed = a.v.SealBlob(secret, totpAAD)
	return secret, sealed, codes, Enrollment{URI: TOTPURI(account, secret), Secret: FormatTOTPSecret(secret), RecoveryCodes: codes}
}

// CreateUser makes an account and returns its authenticator enrollment. Called only from the CLI.
func (a *Auth) CreateUser(username, password string) (Enrollment, error) {
	if !usernameRe.MatchString(username) {
		return Enrollment{}, errors.New("username must be 3-32 characters: lowercase letters, digits, . _ -, starting with a letter")
	}
	hash, err := HashPassword(password)
	if err != nil {
		return Enrollment{}, err
	}
	_, sealed, codes, enr := a.enroll(username)
	if _, err := a.st.CreateUser(store.User{Username: username, PasswordHash: hash, TOTPSecret: sealed}, a.recoveryMACs(codes)); err != nil {
		return Enrollment{}, err
	}
	return enr, nil
}

func (a *Auth) SetPassword(username, password string) error {
	u, ok, err := a.st.UserByName(username)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no user %q", username)
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	return a.st.SetPasswordHash(u.ID, hash)
}

func (a *Auth) ResetTOTP(username string) (Enrollment, error) {
	u, ok, err := a.st.UserByName(username)
	if err != nil {
		return Enrollment{}, err
	}
	if !ok {
		return Enrollment{}, fmt.Errorf("no user %q", username)
	}
	_, sealed, codes, enr := a.enroll(username)
	if err := a.st.ReplaceTOTP(u.ID, sealed, a.recoveryMACs(codes)); err != nil {
		return Enrollment{}, err
	}
	return enr, nil
}

func (a *Auth) LinkGitHub(username string, githubID int64) error {
	u, ok, err := a.st.UserByName(username)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no user %q", username)
	}
	return a.st.SetGitHubID(u.ID, githubID)
}

func isSixDigits(s string) bool {
	if len(s) != 6 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// secondFactor turns the typed code into a proof. A TOTP code is checked here; a recovery code is only
// recognised by shape and is spent (or refused) atomically by store.CompleteLogin.
func (a *Auth) secondFactor(u store.User, code string) (store.LoginProof, bool) {
	code = strings.TrimSpace(code)
	if isSixDigits(code) {
		secret, err := a.v.OpenBlob(u.TOTPSecret, totpAAD)
		if err != nil {
			return store.LoginProof{}, false
		}
		step, ok := VerifyTOTP(secret, code, a.Now(), u.TOTPLastStep)
		return store.LoginProof{Step: step}, ok
	}
	norm := NormalizeRecovery(code)
	if len(norm) != 10 {
		return store.LoginProof{}, false
	}
	return store.LoginProof{RecoveryMAC: a.v.MAC("recovery", []byte(norm))}, true
}

func shortHash(s string) string { return store.HashToken(s)[:16] }

func (a *Auth) finish(ip, ua string, u store.User, p store.LoginProof) (string, error) {
	token, hash := newSessionToken()
	now := a.Now()
	ok, err := a.st.CompleteLogin(u.ID, p, store.NewSession{
		IDHash: hash, Now: now, ExpiresAt: a.expiry(now, now), IP: ip, UAHash: shortHash(ua),
	})
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrInvalid
	}
	return token, nil
}

// Login verifies username, password and a TOTP or recovery code. th is the throttle of the listener the
// request arrived on; private selects the reserved hashing slot. Every kind of failure is ErrInvalid.
func (a *Auth) Login(th *Throttle, private bool, ip, ua, username, password, code string) (string, error) {
	if wait, ok := th.Check(ip); !ok {
		return "", &BlockedError{RetryAfter: wait}
	}
	if len(username) > 64 || len(password) > MaxPasswordLen || len(code) > 32 {
		th.Fail(ip)
		return "", ErrInvalid
	}
	u, found, err := a.st.UserByName(username)
	if err != nil {
		return "", err
	}
	hash := a.dummy // an unknown user still costs one hash
	if found {
		hash = u.PasswordHash
	}
	okPw, err := a.h.Verify(password, hash, private)
	if errors.Is(err, ErrBusy) {
		return "", ErrBusy
	}
	if err != nil {
		return "", err
	}
	if !found || !okPw {
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
	th.Clear(ip)
	return token, nil
}

// Session resolves a session cookie value to its user, extending the idle window at most once a minute.
func (a *Auth) Session(token string) (store.User, bool) {
	if token == "" || len(token) > 100 {
		return store.User{}, false
	}
	h := store.HashToken(token)
	si, ok, err := a.st.SessionByHash(h)
	if err != nil || !ok {
		return store.User{}, false
	}
	now := a.Now()
	if !now.Before(si.ExpiresAt) {
		_ = a.st.DeleteSession(h)
		return store.User{}, false
	}
	if now.Sub(si.LastSeen) >= time.Minute {
		_ = a.st.TouchSession(h, now, a.expiry(now, si.CreatedAt))
	}
	u, ok, err := a.st.UserByID(si.UserID)
	if err != nil || !ok {
		return store.User{}, false
	}
	return u, true
}

func (a *Auth) Logout(token string) {
	if token != "" {
		_ = a.st.DeleteSession(store.HashToken(token))
	}
}
