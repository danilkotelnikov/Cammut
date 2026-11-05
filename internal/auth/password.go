// Package auth implements the console login: argon2id passwords, TOTP, per-IP throttling and sessions.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	argonMem     = 19 * 1024 // KiB
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
	saltLen      = 16
	maxArgonMem  = 64 * 1024

	MinPasswordLen = 14
	MaxPasswordLen = 256
)

// ErrBusy means every hashing slot is taken; the caller should answer 503, not queue.
var ErrBusy = errors.New("auth: all hashing slots are busy")

var b64 = base64.RawStdEncoding

// Hasher bounds concurrent argon2 work. Public requests share pub slots; the private (SSH-only) listener may
// additionally use priv slots that the public side can never take, so a flood cannot lock the admin out.
type Hasher struct{ pub, priv chan struct{} }

func NewHasher(pub, priv int) *Hasher {
	return &Hasher{pub: make(chan struct{}, pub), priv: make(chan struct{}, priv)}
}

func (h *Hasher) acquire(private bool) (release func(), ok bool) {
	if private {
		select {
		case h.priv <- struct{}{}:
			return func() { <-h.priv }, true
		default:
		}
	}
	select {
	case h.pub <- struct{}{}:
		return func() { <-h.pub }, true
	default:
		return nil, false
	}
}

func encode(salt, key []byte) string {
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMem, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key))
}

func decode(s string) (m, t uint32, p uint8, salt, key []byte, err error) {
	bad := errors.New("auth: unsupported password hash")
	parts := strings.Split(s, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return 0, 0, 0, nil, nil, bad
	}
	var v int
	if _, err = fmt.Sscanf(parts[2], "v=%d", &v); err != nil || v != argon2.Version {
		return 0, 0, 0, nil, nil, bad
	}
	if _, err = fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return 0, 0, 0, nil, nil, bad
	}
	if m == 0 || m > maxArgonMem || t == 0 || t > 10 || p == 0 {
		return 0, 0, 0, nil, nil, bad
	}
	if salt, err = b64.DecodeString(parts[4]); err != nil || len(salt) < 8 {
		return 0, 0, 0, nil, nil, bad
	}
	if key, err = b64.DecodeString(parts[5]); err != nil || len(key) < 16 {
		return 0, 0, 0, nil, nil, bad
	}
	return m, t, p, salt, key, nil
}

// HashPassword hashes a new password. It does not use the admission pool; it is for the CLI.
func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLen || len(password) > MaxPasswordLen {
		return "", fmt.Errorf("password must be %d-%d bytes", MinPasswordLen, MaxPasswordLen)
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return encode(salt, argon2.IDKey([]byte(password), salt, argonTime, argonMem, argonThreads, argonKeyLen)), nil
}

// Verify checks password against an encoded hash. It answers ErrBusy at once when no slot is free.
func (h *Hasher) Verify(password, encoded string, private bool) (bool, error) {
	release, ok := h.acquire(private)
	if !ok {
		return false, ErrBusy
	}
	defer release()
	m, t, p, salt, key, err := decode(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(key)))
	return subtle.ConstantTimeCompare(got, key) == 1, nil
}
