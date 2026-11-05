package admin

import (
	"net/http"
	"strconv"
	"testing"
)

func TestLoginThrottleUsesLastTrustedForwardedAddressAndCSRFStillApplies(t *testing.T) {
	a := newAPI(t, nil)
	body := map[string]string{"username": "alice", "password": "wrong password here", "code": "000000"}
	for i := 0; i < 5; i++ {
		// The untrusted earlier hop changes each time; only the appended last address is used.
		hops := "198.51.100." + strconv.Itoa(i+1) + ", 203.0.113.7"
		if got := a.req("POST", "/api/v1/login", body, "", func(r *http.Request) {
			r.Header.Set("X-Forwarded-For", hops)
		}).StatusCode; got != 401 {
			t.Fatalf("attempt %d: got %d want 401", i, got)
		}
	}
	if resp := a.req("POST", "/api/v1/login", body, "", func(r *http.Request) {
		r.Header.Set("X-Forwarded-For", "192.0.2.9, 203.0.113.7")
	}); resp.StatusCode != 429 || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("earlier forwarded address must not reset throttle: got %d", resp.StatusCode)
	}
	if got := a.req("POST", "/api/v1/login", body, "", func(r *http.Request) {
		r.Header.Set("X-Forwarded-For", "203.0.113.8")
		r.Header.Set("Origin", "https://evil.example")
	}).StatusCode; got != 403 {
		t.Fatalf("origin restriction must still apply to a different address: got %d", got)
	}
}
