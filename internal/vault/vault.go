// Package vault seals secrets with XChaCha20-Poly1305 under keys derived from one 32-byte key file.
package vault

import (
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"

	"cammut/internal/store"
)

const (
	KeySize     = 32
	maxValueLen = 8192
)

var nameRe = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)

func timeNow() time.Time { return time.Now() }

// ValidName reports whether name is an acceptable secret name (same rule as environment variable names).
func ValidName(name string) bool { return nameRe.MatchString(name) }

// ValidValue rejects values that cannot be a bare token: empty, oversize, control characters, edge spaces.
func ValidValue(v string) error {
	if v == "" || len(v) > maxValueLen {
		return fmt.Errorf("secret value must be 1-%d bytes", maxValueLen)
	}
	if strings.TrimSpace(v) != v {
		return errors.New("secret value must not start or end with spaces")
	}
	for _, r := range v {
		if r < 0x20 || r == 0x7f {
			return errors.New("secret value must not contain control characters")
		}
	}
	return nil
}

// LoadKey reads the key file. It must be exactly KeySize bytes and not accessible by group or others.
func LoadKey(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("vault key: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("vault key %s is accessible by group or others (mode %v); use 0400", path, info.Mode().Perm())
	}
	key, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("vault key: %w", err)
	}
	if len(key) != KeySize {
		return nil, fmt.Errorf("vault key %s has %d bytes, want %d", path, len(key), KeySize)
	}
	return key, nil
}

// InitKey writes a fresh random key with mode 0400 and refuses to replace an existing file.
func InitKey(path string) error {
	key := make([]byte, KeySize)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		return err
	}
	if _, err := f.Write(key); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	return f.Close()
}

type Vault struct {
	st     *store.Store
	aead   cipher.AEAD
	macKey []byte
}

func derive(master []byte, purpose string) []byte {
	b := make([]byte, 32)
	io.ReadFull(hkdf.New(sha256.New, master, nil, []byte("cammut/"+purpose)), b)
	return b
}

func New(key []byte, st *store.Store) (*Vault, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("vault key must be %d bytes", KeySize)
	}
	aead, err := chacha20poly1305.NewX(derive(key, "aead"))
	if err != nil {
		return nil, err
	}
	return &Vault{st: st, aead: aead, macKey: derive(key, "mac")}, nil
}

// SealBlob returns nonce||ciphertext for plain, bound to aad.
func (v *Vault) SealBlob(plain, aad []byte) []byte {
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return v.aead.Seal(nonce, nonce, plain, aad)
}

func (v *Vault) OpenBlob(blob, aad []byte) ([]byte, error) {
	n := v.aead.NonceSize()
	if len(blob) < n+v.aead.Overhead() {
		return nil, errors.New("vault: blob too short")
	}
	plain, err := v.aead.Open(nil, blob[:n], blob[n:], aad)
	if err != nil {
		return nil, errors.New("vault: authentication failed")
	}
	return plain, nil
}

func secretAAD(name string) []byte { return []byte("secret:" + name) }

func (v *Vault) Put(name, value string) error {
	if !ValidName(name) {
		return fmt.Errorf("invalid secret name %q", name)
	}
	if err := ValidValue(value); err != nil {
		return err
	}
	blob := v.SealBlob([]byte(value), secretAAD(name))
	n := v.aead.NonceSize()
	return v.st.PutSecret(name, blob[:n], blob[n:], timeNow())
}

func (v *Vault) Get(name string) (string, bool, error) {
	nonce, ct, ok, err := v.st.GetSecret(name)
	if err != nil || !ok {
		return "", false, err
	}
	plain, err := v.OpenBlob(append(append([]byte{}, nonce...), ct...), secretAAD(name))
	if err != nil {
		return "", false, err
	}
	return string(plain), true, nil
}

func (v *Vault) Delete(name string) (bool, error) { return v.st.DeleteSecret(name) }

func (v *Vault) Meta() ([]store.SecretMeta, error) { return v.st.ListSecretMeta() }

// MAC is a hex HMAC-SHA256 of data under a key that is separate for every purpose.
func (v *Vault) MAC(purpose string, data []byte) string {
	h := hmac.New(sha256.New, derive(v.macKey, "mac/"+purpose))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
