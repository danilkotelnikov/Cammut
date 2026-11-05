// Package ratelimit is a small per-id token bucket.
package ratelimit

import (
	"math"
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter allows ratePerSec requests per second per id with the given burst.
// ponytail: buckets are never evicted; fine for a handful of tokens, add expiry if ids become unbounded.
type Limiter struct {
	mu    sync.Mutex
	rate  float64
	burst float64
	m     map[int64]*bucket
}

func New(ratePerSec float64, burst int) *Limiter {
	return &Limiter{rate: ratePerSec, burst: float64(burst), m: map[int64]*bucket{}}
}

func (l *Limiter) Allow(id int64, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.m[id]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.m[id] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
