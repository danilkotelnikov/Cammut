package auth

import (
	"sync"
	"time"
)

const (
	freeFailures = 5
	baseBlock    = time.Minute
	maxBlock     = 15 * time.Minute
	forgetAfter  = time.Hour
	maxTracked   = 10000
)

type tEntry struct {
	fails        int
	blockedUntil time.Time
	last         time.Time
}

// Throttle slows repeated failures per client address. It never locks a username, so nobody can lock the
// admin out by guessing at the admin's name from somewhere else.
type Throttle struct {
	mu  sync.Mutex
	m   map[string]*tEntry
	now func() time.Time
	max int
}

func NewThrottle(now func() time.Time) *Throttle {
	if now == nil {
		now = time.Now
	}
	return &Throttle{m: map[string]*tEntry{}, now: now, max: maxTracked}
}

// Check reports whether ip may try now and, when it may not, how long to wait.
func (t *Throttle) Check(ip string) (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.m[ip]
	if e == nil {
		return 0, true
	}
	if now := t.now(); now.Before(e.blockedUntil) {
		return e.blockedUntil.Sub(now), false
	}
	return 0, true
}

// Fail records a failed attempt. Attempts that Check refused must not be passed here; a failure that arrives
// while the address is blocked is ignored so it cannot extend the block.
func (t *Throttle) Fail(ip string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	e := t.m[ip]
	if e == nil {
		if len(t.m) >= t.max {
			t.evict(now)
		}
		e = &tEntry{}
		t.m[ip] = e
	}
	if now.Before(e.blockedUntil) {
		return
	}
	if now.Sub(e.last) > forgetAfter {
		e.fails = 0
	}
	e.last = now
	e.fails++
	if e.fails >= freeFailures {
		d := maxBlock
		if n := e.fails - freeFailures; n < 5 {
			if d = baseBlock << n; d > maxBlock {
				d = maxBlock
			}
		}
		e.blockedUntil = now.Add(d)
	}
}

func (t *Throttle) Clear(ip string) {
	t.mu.Lock()
	delete(t.m, ip)
	t.mu.Unlock()
}

// evict drops idle entries and, if the table is still full, the least recently used one.
func (t *Throttle) evict(now time.Time) {
	var oldestKey string
	var oldest time.Time
	for k, e := range t.m {
		if now.Sub(e.last) > forgetAfter && !now.Before(e.blockedUntil) {
			delete(t.m, k)
			continue
		}
		if oldestKey == "" || e.last.Before(oldest) {
			oldestKey, oldest = k, e.last
		}
	}
	if len(t.m) >= t.max && oldestKey != "" {
		delete(t.m, oldestKey)
	}
}
