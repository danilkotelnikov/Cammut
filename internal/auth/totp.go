package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const totpPeriod = 30

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func GenerateTOTPSecret() []byte {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func FormatTOTPSecret(secret []byte) string { return b32.EncodeToString(secret) }

func TOTPURI(account string, secret []byte) string {
	q := url.Values{}
	q.Set("secret", FormatTOTPSecret(secret))
	q.Set("issuer", "Cammut")
	q.Set("algorithm", "SHA1")
	q.Set("digits", "6")
	q.Set("period", "30")
	return "otpauth://totp/" + url.PathEscape("Cammut:"+account) + "?" + q.Encode()
}

// totpAt is RFC 4226 HOTP over the time step with HMAC-SHA-1 and six digits.
func totpAt(secret []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	code := (binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff) % 1_000_000
	return fmt.Sprintf("%06d", code)
}

// TOTPNow returns the code an authenticator would show at now (used by the CLI tests).
func TOTPNow(secret []byte, now time.Time) string { return totpAt(secret, now.Unix()/totpPeriod) }

// VerifyTOTP accepts the current time step and one on either side, but only a step strictly newer than
// lastStep, so a code works once. The caller must record the returned step atomically (store.CompleteLogin).
func VerifyTOTP(secret []byte, code string, now time.Time, lastStep int64) (int64, bool) {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return 0, false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	cur := now.Unix() / totpPeriod
	var matched int64
	for _, d := range []int64{-1, 0, 1} {
		s := cur + d
		if subtle.ConstantTimeCompare([]byte(totpAt(secret, s)), []byte(code)) == 1 && s > lastStep && s > matched {
			matched = s
		}
	}
	return matched, matched != 0
}

const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 32 symbols, no I, O, 0, 1

// GenerateRecoveryCodes returns n codes of ten symbols (50 bits) written XXXXX-XXXXX.
func GenerateRecoveryCodes(n int) []string {
	out := make([]string, n)
	for i := range out {
		b := make([]byte, 10)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		for j := range b {
			b[j] = recoveryAlphabet[b[j]&31]
		}
		out[i] = string(b[:5]) + "-" + string(b[5:])
	}
	return out
}

// NormalizeRecovery upper-cases a typed code and drops dashes and spaces.
func NormalizeRecovery(s string) string {
	s = strings.ToUpper(s)
	s = strings.ReplaceAll(s, "-", "")
	return strings.ReplaceAll(s, " ", "")
}
