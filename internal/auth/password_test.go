package auth

import (
	"errors"
	"strings"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	enc, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected format %q", enc)
	}
	h := NewHasher(2, 1)
	if ok, err := h.Verify("correct horse battery", enc, false); err != nil || !ok {
		t.Fatalf("right password: %v %v", ok, err)
	}
	if ok, err := h.Verify("correct horse batterz", enc, false); err != nil || ok {
		t.Fatalf("wrong password: %v %v", ok, err)
	}
	other, _ := HashPassword("correct horse battery")
	if other == enc {
		t.Fatal("two hashes of one password must differ (random salt)")
	}
}

func TestPasswordLengthBounds(t *testing.T) {
	if _, err := HashPassword(strings.Repeat("a", MinPasswordLen-1)); err == nil {
		t.Fatal("a short password must be refused")
	}
	if _, err := HashPassword(strings.Repeat("a", MaxPasswordLen+1)); err == nil {
		t.Fatal("an over-long password must be refused")
	}
	if _, err := HashPassword(strings.Repeat("a", MinPasswordLen)); err != nil {
		t.Fatalf("the minimum length must be accepted: %v", err)
	}
}

func TestVerifyRejectsGarbageWithoutPanicking(t *testing.T) {
	h := NewHasher(1, 1)
	for _, bad := range []string{"", "plain", "$argon2id$v=19$m=1,t=1$x$y", "$argon2id$v=19$m=999999999,t=2,p=1$AAAA$AAAA", "$argon2i$v=19$m=19456,t=2,p=1$AAAA$AAAA", "$argon2id$v=18$m=19456,t=2,p=1$AAAA$AAAA"} {
		if ok, err := h.Verify("whatever-password", bad, false); ok || err == nil {
			t.Fatalf("hash %q must be an error, not a pass (ok=%v err=%v)", bad, ok, err)
		}
	}
}

func TestAdmissionIsNonBlockingAndTheAdminSlotIsReserved(t *testing.T) {
	enc, _ := HashPassword("correct horse battery")
	h := NewHasher(1, 1)
	release, ok := h.acquire(false)
	if !ok {
		t.Fatal("first public slot")
	}
	if _, err := h.Verify("correct horse battery", enc, false); !errors.Is(err, ErrBusy) {
		t.Fatalf("a full public pool must answer ErrBusy at once, got %v", err)
	}
	if ok, err := h.Verify("correct horse battery", enc, true); err != nil || !ok {
		t.Fatalf("the private listener must still get its reserved slot: %v %v", ok, err)
	}
	release()
	if ok, err := h.Verify("correct horse battery", enc, false); err != nil || !ok {
		t.Fatalf("after release the public pool works again: %v %v", ok, err)
	}
	if _, err := NewHasher(0, 0).Verify("x", enc, true); !errors.Is(err, ErrBusy) {
		t.Fatalf("a zero-slot hasher is always busy, got %v", err)
	}
	// a public request must never use the reserved slot
	h2 := NewHasher(0, 1)
	if _, err := h2.Verify("correct horse battery", enc, false); !errors.Is(err, ErrBusy) {
		t.Fatalf("the public side must not borrow the reserved slot, got %v", err)
	}
}
