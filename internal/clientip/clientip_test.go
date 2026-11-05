package clientip

import (
	"net/http"
	"testing"
)

func req(remote string, xff ...string) *http.Request {
	r, _ := http.NewRequest("GET", "http://x/", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestFromRequest(t *testing.T) {
	cases := []struct {
		name string
		r    *http.Request
		want string
	}{
		{"direct peer", req("203.0.113.5:4000"), "203.0.113.5"},
		{"direct peer ignores a spoofed header", req("203.0.113.5:4000", "6.6.6.6"), "203.0.113.5"},
		{"loopback without header", req("127.0.0.1:5555"), "127.0.0.1"},
		{"loopback with the proxy's header", req("127.0.0.1:5555", "198.51.100.7"), "198.51.100.7"},
		{"the last element wins, earlier ones may be forged", req("127.0.0.1:5555", "6.6.6.6, 198.51.100.7"), "198.51.100.7"},
		{"ipv6 client", req("[::1]:5555", "2001:db8::7"), "2001:db8::7"},
		{"garbage header falls back to the peer", req("127.0.0.1:5555", "not-an-ip"), "127.0.0.1"},
		{"peer without a port", req("127.0.0.1", "198.51.100.7"), "198.51.100.7"},
		{"ipv6 loopback peer", req("[::1]:1", "198.51.100.7"), "198.51.100.7"},
		{"private non-loopback peer is not trusted", req("10.0.0.5:1", "198.51.100.7"), "10.0.0.5"},
	}
	for _, c := range cases {
		if got := FromRequest(c.r); got != c.want {
			t.Fatalf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
