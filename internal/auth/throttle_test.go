package auth

import (
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTh() (*Throttle, *fakeClock) {
	c := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	return NewThrottle(c.now), c
}

func fails(th *Throttle, ip string, n int) {
	for i := 0; i < n; i++ {
		th.Fail(ip)
	}
}

func TestFourFailuresAreFreeTheFifthBlocksForAMinute(t *testing.T) {
	th, clk := newTh()
	fails(th, "1.1.1.1", 4)
	if _, ok := th.Check("1.1.1.1"); !ok {
		t.Fatal("four failures must not block")
	}
	th.Fail("1.1.1.1")
	d, ok := th.Check("1.1.1.1")
	if ok || d != time.Minute {
		t.Fatalf("after five failures: ok=%v wait=%v", ok, d)
	}
	clk.advance(59 * time.Second)
	if d, ok := th.Check("1.1.1.1"); ok || d != time.Second {
		t.Fatalf("still blocked for 1s: ok=%v wait=%v", ok, d)
	}
	clk.advance(2 * time.Second)
	if _, ok := th.Check("1.1.1.1"); !ok {
		t.Fatal("the block must end after a minute")
	}
}

func TestBlocksDoubleUpToFifteenMinutes(t *testing.T) {
	th, clk := newTh()
	fails(th, "2.2.2.2", 5)
	want := []time.Duration{2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute, 15 * time.Minute}
	for i, w := range want {
		clk.advance(16 * time.Minute) // past any block, still inside the one-hour memory
		th.Fail("2.2.2.2")
		if d, ok := th.Check("2.2.2.2"); ok || d != w {
			t.Fatalf("step %d: ok=%v wait=%v want %v", i, ok, d, w)
		}
	}
}

func TestBlockedAttemptsDoNotExtendTheBlock(t *testing.T) {
	th, clk := newTh()
	fails(th, "3.3.3.3", 5)
	clk.advance(30 * time.Second)
	for i := 0; i < 50; i++ { // a client hammering while blocked
		th.Fail("3.3.3.3")
	}
	if d, ok := th.Check("3.3.3.3"); ok || d != 30*time.Second {
		t.Fatalf("hammering must not extend the block: ok=%v wait=%v", ok, d)
	}
}

func TestOtherAddressesAreUnaffectedAndSuccessClears(t *testing.T) {
	th, _ := newTh()
	fails(th, "4.4.4.4", 9)
	if _, ok := th.Check("5.5.5.5"); !ok {
		t.Fatal("one address must not block another")
	}
	th.Clear("4.4.4.4")
	if _, ok := th.Check("4.4.4.4"); !ok {
		t.Fatal("a successful login must clear the address")
	}
	fails(th, "4.4.4.4", 4)
	if _, ok := th.Check("4.4.4.4"); !ok {
		t.Fatal("the counter must have restarted after Clear")
	}
}

func TestIdleHourForgetsFailures(t *testing.T) {
	th, clk := newTh()
	fails(th, "6.6.6.6", 4)
	clk.advance(61 * time.Minute)
	th.Fail("6.6.6.6") // would be the fifth, but the first four are forgotten
	if _, ok := th.Check("6.6.6.6"); !ok {
		t.Fatal("old failures must be forgotten after an idle hour")
	}
}

func TestTrackedAddressesAreBounded(t *testing.T) {
	th, clk := newTh()
	th.max = 100
	for i := 0; i < 1000; i++ {
		clk.advance(time.Second)
		th.Fail("10.0." + string(rune('a'+i%26)) + "." + string(rune('a'+(i/26)%26)) + string(rune('a'+(i/676)%26)))
	}
	if len(th.m) > th.max {
		t.Fatalf("tracking %d addresses, cap is %d", len(th.m), th.max)
	}
}
