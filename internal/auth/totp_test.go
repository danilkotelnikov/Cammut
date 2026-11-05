package auth

import (
	"strings"
	"testing"
	"time"
)

var rfcSecret = []byte("12345678901234567890") // RFC 6238 SHA-1 test secret

func TestTOTPMatchesRFC6238Vectors(t *testing.T) {
	// 8-digit RFC values 94287082, 07081804, 14050471, 89005924, 69279037, 65353130 -> last six digits
	cases := []struct {
		unix int64
		want string
	}{
		{59, "287082"}, {1111111109, "081804"}, {1111111111, "050471"},
		{1234567890, "005924"}, {2000000000, "279037"}, {20000000000, "353130"},
	}
	for _, c := range cases {
		if got := totpAt(rfcSecret, c.unix/30); got != c.want {
			t.Fatalf("t=%d: got %s want %s", c.unix, got, c.want)
		}
	}
}

func TestVerifyTOTPWindowAndReplay(t *testing.T) {
	now := time.Unix(1_800_000_015, 0)
	cur := now.Unix() / 30
	for _, tc := range []struct {
		name string
		step int64
		last int64
		ok   bool
	}{
		{"current", cur, 0, true},
		{"previous", cur - 1, 0, true},
		{"next", cur + 1, 0, true},
		{"two behind", cur - 2, 0, false},
		{"two ahead", cur + 2, 0, false},
		{"already used", cur, cur, false},
		{"older than last used", cur - 1, cur, false},
		{"newer than last used", cur + 1, cur, true},
	} {
		step, ok := VerifyTOTP(rfcSecret, totpAt(rfcSecret, tc.step), now, tc.last)
		if ok != tc.ok || (ok && step != tc.step) {
			t.Fatalf("%s: ok=%v step=%d (want ok=%v step=%d)", tc.name, ok, step, tc.ok, tc.step)
		}
	}
	for _, bad := range []string{"", "12345", "1234567", "12345a", "      ", "abcdef"} {
		if _, ok := VerifyTOTP(rfcSecret, bad, now, 0); ok {
			t.Fatalf("malformed code %q must be refused", bad)
		}
	}
	if _, ok := VerifyTOTP(rfcSecret, " "+totpAt(rfcSecret, cur)+" ", now, 0); !ok {
		t.Fatal("surrounding spaces from a paste are tolerated")
	}
}

func TestTOTPURIAndSecret(t *testing.T) {
	s := GenerateTOTPSecret()
	if len(s) != 20 {
		t.Fatalf("secret length %d", len(s))
	}
	uri := TOTPURI("alice", s)
	for _, want := range []string{"otpauth://totp/Cammut:alice?", "secret=" + FormatTOTPSecret(s), "issuer=Cammut", "digits=6", "period=30", "algorithm=SHA1"} {
		if !strings.Contains(uri, want) {
			t.Fatalf("uri %q lacks %q", uri, want)
		}
	}
	back, err := b32.DecodeString(FormatTOTPSecret(s))
	if err != nil || string(back) != string(s) {
		t.Fatal("secret must round-trip through base32")
	}
}

func TestRecoveryCodes(t *testing.T) {
	codes := GenerateRecoveryCodes(8)
	if len(codes) != 8 {
		t.Fatalf("got %d codes", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 11 || c[5] != '-' {
			t.Fatalf("format %q", c)
		}
		if seen[c] {
			t.Fatalf("duplicate code %q", c)
		}
		seen[c] = true
		if strings.ContainsAny(c, "01IO") {
			t.Fatalf("ambiguous character in %q", c)
		}
		if NormalizeRecovery(c) != strings.ReplaceAll(c, "-", "") {
			t.Fatalf("normalize %q", c)
		}
	}
	if NormalizeRecovery(" abcde-fghjk ") != "ABCDEFGHJK" {
		t.Fatalf("normalize: %q", NormalizeRecovery(" abcde-fghjk "))
	}
}
