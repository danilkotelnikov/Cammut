// Package acl implements Cammut's scope matching. Scopes are default-deny.
package acl

import "strings"

// Allowed reports whether any scope grants upstream/tool. No scopes means no access.
func Allowed(scopes []string, upstream, tool string) bool {
	for _, s := range scopes {
		su, st := split(s)
		if glob(su, upstream) && glob(st, tool) {
			return true
		}
	}
	return false
}

// UpstreamVisible reports whether any scope could grant something on upstream.
func UpstreamVisible(scopes []string, upstream string) bool {
	for _, s := range scopes {
		su, _ := split(s)
		if glob(su, upstream) {
			return true
		}
	}
	return false
}

// split turns "up/tool" into ("up","tool"); a bare "up" means all its tools.
func split(scope string) (up, tool string) {
	if i := strings.IndexByte(scope, '/'); i >= 0 {
		return scope[:i], scope[i+1:]
	}
	return scope, "*"
}

// glob matches s against p where '*' matches any run of characters (including '/').
func glob(p, s string) bool {
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for _, mid := range parts[1 : len(parts)-1] {
		i := strings.Index(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return strings.HasSuffix(s, parts[len(parts)-1])
}
