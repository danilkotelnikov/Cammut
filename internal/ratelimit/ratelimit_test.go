package ratelimit

import (
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	l := New(1, 3)
	t0 := time.Unix(1000, 0)
	for i := 0; i < 3; i++ {
		if !l.Allow(1, t0) {
			t.Fatalf("burst call %d was denied", i)
		}
	}
	if l.Allow(1, t0) {
		t.Fatal("4th immediate call must be denied")
	}
	if !l.Allow(2, t0) {
		t.Fatal("other ids are independent")
	}
	later := t0.Add(1100 * time.Millisecond)
	if !l.Allow(1, later) {
		t.Fatal("one token should have refilled after about a second")
	}
	if l.Allow(1, later) {
		t.Fatal("only one token was refilled")
	}
}
