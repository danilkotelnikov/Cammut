package vault

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cammut/internal/store"
)

func newVault(t *testing.T) (*Vault, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "v.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	key := bytes.Repeat([]byte{7}, KeySize)
	v, err := New(key, st)
	if err != nil {
		t.Fatal(err)
	}
	return v, st
}

func TestPutGetDeleteRoundTrip(t *testing.T) {
	v, st := newVault(t)
	if err := v.Put("GITHUB_PAT", "github_pat_abc123"); err != nil {
		t.Fatal(err)
	}
	got, ok, err := v.Get("GITHUB_PAT")
	if err != nil || !ok || got != "github_pat_abc123" {
		t.Fatalf("get: %q %v %v", got, ok, err)
	}
	nonce, ct, _, _ := st.GetSecret("GITHUB_PAT")
	if bytes.Contains(ct, []byte("github_pat")) || bytes.Contains(nonce, []byte("github_pat")) {
		t.Fatal("the value is stored in clear")
	}
	meta, _ := v.Meta()
	if len(meta) != 1 || meta[0].Name != "GITHUB_PAT" {
		t.Fatalf("meta: %+v", meta)
	}
	if _, ok, _ := v.Get("NOPE"); ok {
		t.Fatal("unknown secret must report false")
	}
	if ok, _ := v.Delete("GITHUB_PAT"); !ok {
		t.Fatal("delete")
	}
	if _, ok, _ := v.Get("GITHUB_PAT"); ok {
		t.Fatal("deleted secret still readable")
	}
}

func TestCiphertextIsBoundToItsName(t *testing.T) {
	v, st := newVault(t)
	if err := v.Put("A_SECRET", "value-a"); err != nil {
		t.Fatal(err)
	}
	nonce, ct, _, _ := st.GetSecret("A_SECRET")
	if err := st.PutSecret("B_SECRET", nonce, ct, timeNow()); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := v.Get("B_SECRET"); ok || err == nil {
		t.Fatalf("a ciphertext copied to another name must not open (ok=%v err=%v)", ok, err)
	}
}

func TestTamperingIsDetected(t *testing.T) {
	v, st := newVault(t)
	v.Put("A_SECRET", "value-a")
	nonce, ct, _, _ := st.GetSecret("A_SECRET")
	ct[0] ^= 1
	st.PutSecret("A_SECRET", nonce, ct, timeNow())
	if _, _, err := v.Get("A_SECRET"); err == nil {
		t.Fatal("a flipped byte must fail authentication")
	}
}

func TestSealBlobAndMAC(t *testing.T) {
	v, _ := newVault(t)
	a := v.SealBlob([]byte("totp-secret"), []byte("aad"))
	b := v.SealBlob([]byte("totp-secret"), []byte("aad"))
	if bytes.Equal(a, b) {
		t.Fatal("two seals of the same plaintext must differ (fresh nonce)")
	}
	got, err := v.OpenBlob(a, []byte("aad"))
	if err != nil || string(got) != "totp-secret" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := v.OpenBlob(a, []byte("other")); err == nil {
		t.Fatal("wrong aad must fail")
	}
	if _, err := v.OpenBlob(a[:5], []byte("aad")); err == nil {
		t.Fatal("a truncated blob must fail, not panic")
	}
	if v.MAC("recovery", []byte("X")) != v.MAC("recovery", []byte("X")) {
		t.Fatal("MAC must be deterministic")
	}
	if v.MAC("recovery", []byte("X")) == v.MAC("other", []byte("X")) {
		t.Fatal("MAC keys must be separated by purpose")
	}
	if len(v.MAC("recovery", nil)) != 64 {
		t.Fatal("MAC is hex SHA-256")
	}
}

func TestDifferentKeysCannotReadEachOther(t *testing.T) {
	v1, st := newVault(t)
	v1.Put("A_SECRET", "value-a")
	v2, err := New(bytes.Repeat([]byte{9}, KeySize), st)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := v2.Get("A_SECRET"); err == nil {
		t.Fatal("another key must not open the secret")
	}
}

func TestKeyFileFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.key")
	if _, err := LoadKey(path); err == nil {
		t.Fatal("a missing key file must be an error")
	}
	if err := InitKey(path); err != nil {
		t.Fatal(err)
	}
	key, err := LoadKey(path)
	if err != nil || len(key) != KeySize {
		t.Fatalf("load: %d %v", len(key), err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o400 {
		t.Fatalf("key mode %v, want 0400", info.Mode().Perm())
	}
	if err := InitKey(path); err == nil {
		t.Fatal("InitKey must never overwrite an existing key")
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKey(path); err == nil {
		t.Fatal("a world-readable key file must be refused")
	}
	short := filepath.Join(dir, "short.key")
	if err := os.WriteFile(short, []byte("tooshort"), 0o400); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKey(short); err == nil {
		t.Fatal("a short key file must be refused")
	}
	if _, err := New(make([]byte, 5), nil); err == nil {
		t.Fatal("New must reject a short key")
	}
}

func TestNameAndValueValidation(t *testing.T) {
	v, _ := newVault(t)
	for _, name := range []string{"", "lower", "HAS SPACE", "NEW\nLINE", strings.Repeat("A", 65), "9START", "A-B"} {
		if ValidName(name) {
			t.Fatalf("name %q must be invalid", name)
		}
		if err := v.Put(name, "x"); err == nil {
			t.Fatalf("Put must reject name %q", name)
		}
	}
	for _, name := range []string{"GITHUB_PAT", "_X", "A1_B2"} {
		if !ValidName(name) {
			t.Fatalf("name %q must be valid", name)
		}
	}
	for _, val := range []string{"", "has\nnewline", "has\x00nul", " leading", "trailing ", strings.Repeat("x", 8193)} {
		if err := v.Put("OK_NAME", val); err == nil {
			t.Fatalf("Put must reject value %q", val)
		}
	}
	if err := v.Put("OK_NAME", "github_pat_11AAA_bbb"); err != nil {
		t.Fatalf("a normal token must be accepted: %v", err)
	}
}
