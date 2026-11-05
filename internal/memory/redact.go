package memory

import (
	"math"
	"regexp"
	"strings"
)

// Redact is the Go twin of the adapters' `redact` (adapters/common.mjs RULES): the same rules in the same order,
// pinned by adapters/redact-fixtures.json. RE2 has no backreferences, so the quote-matching rule is written as
// three alternatives (double-quoted, single-quoted, bare). JavaScript's \s is wider than RE2's, so it is spelled
// out here (`ws`).
func Redact(s string) string {
	for _, r := range redactRules {
		if r.fn != nil {
			s = r.re.ReplaceAllStringFunc(s, r.fn)
		} else {
			s = r.re.ReplaceAllString(s, r.repl)
		}
	}
	return s
}

const ws = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

type redactRule struct {
	re   *regexp.Regexp
	repl string
	fn   func(string) string
}

// pat expands "[^{S}" to a negated JS-style \s class and "{s}" to the positive class.
func pat(p string) *regexp.Regexp {
	p = strings.ReplaceAll(p, "[^{S}", "[^"+ws)
	p = strings.ReplaceAll(p, "{s}", "["+ws+"]")
	return regexp.MustCompile(p)
}

func opaque(m string) bool {
	var up, lo, dg bool
	freq := map[rune]int{}
	n := 0
	for _, c := range m {
		switch {
		case c >= 'A' && c <= 'Z':
			up = true
		case c >= 'a' && c <= 'z':
			lo = true
		case c >= '0' && c <= '9':
			dg = true
		}
		freq[c]++
		n++
	}
	if !up || !lo || !dg {
		return false
	}
	h := 0.0
	for _, c := range freq {
		p := float64(c) / float64(n)
		h -= p * math.Log2(p)
	}
	return h >= 3.5
}

var redactRules = []redactRule{
	{re: pat(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`), repl: "[REDACTED:private-key]"},
	{re: pat(`(?i)\bcmt_[0-9a-f]{16,}`), repl: "[REDACTED:token]"},
	{re: pat(`\bsk-[A-Za-z0-9_-]{16,}`), repl: "[REDACTED:key]"},
	{re: pat(`\bgh[pousr]_[A-Za-z0-9]{20,}`), repl: "[REDACTED:token]"},
	{re: pat(`\bgithub_pat_[A-Za-z0-9_]{20,}`), repl: "[REDACTED:token]"},
	{re: pat(`\bAKIA[0-9A-Z]{16}\b`), repl: "[REDACTED:key]"},
	{re: pat(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), repl: "[REDACTED:token]"},
	{re: pat(`\bAIza[0-9A-Za-z_-]{30,}`), repl: "[REDACTED:key]"},
	{re: pat(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), repl: "[REDACTED:jwt]"},
	{re: pat(`(?i)\b(Bearer|Basic){s}+[A-Za-z0-9._~+/=-]{12,}`), repl: "${1} [REDACTED]"},
	{re: pat(`(?i)(\b[a-z][a-z0-9+.-]*://[^{S}:@/]+:)[^{S}@/]+@`), repl: "${1}[REDACTED]@"},
	{re: pat(`(?i)(--?(?:password|passwd|token|secret|api-key|apikey)[= ]+)["']?[^{S}"']+`), repl: "${1}[REDACTED]"},
	// JS: ...({s}*[:=]{s}*)(["']?)[^\s"']{4,}\3 with a backreference; here the three shapes of the value.
	{re: pat(`(?i)\b([\w.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|private[_-]?key|credential)[\w.-]*)({s}*[:=]{s}*)(?:"[^{S}"']{4,}"|'[^{S}"']{4,}'|[^{S}"']{4,})`), repl: "${1}${2}[REDACTED]"},
	{re: pat(`(?i)\b(pass(?:word|wd){s}+is{s}+)[^{S}"']{4,}`), repl: "${1}[REDACTED]"},
	{re: pat(`(?i)(парол[а-яё]*(?:{s}*[:=—]{s}*|{s}+(?:это|is){s}+))[^{S}"']{4,}`), repl: "${1}[REDACTED]"},
	{re: pat(`(?i)\b[0-9a-f]{64,}\b`), repl: "[REDACTED:hex]"},
	{re: pat(`\b[A-Za-z0-9_-]{32,}\b`), fn: func(m string) string {
		if opaque(m) {
			return "[REDACTED:opaque]"
		}
		return m
	}},
}
