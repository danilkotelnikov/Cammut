// Package clientip decides which address to record for a request that may have crossed our own proxy chain.
package clientip

import (
	"net"
	"net/http"
	"strings"
)

// FromRequest returns the TCP peer's address. Only when the peer is loopback (our Caddy) is X-Forwarded-For
// believed, and then only its last element, which our own proxy appended; earlier elements can be forged.
func FromRequest(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
			last := strings.TrimSpace(parts[len(parts)-1])
			if net.ParseIP(last) != nil {
				return last
			}
		}
	}
	return host
}
