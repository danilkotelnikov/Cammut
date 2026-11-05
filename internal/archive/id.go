// Package archive is the blind segment store: age ciphertext on disk plus plaintext metadata in SQLite.
// It holds no key and no decrypt code; it validates the age header magic, sizes and the ciphertext sha256 only.
package archive

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	maxSrcSpan    = 64 << 20  // longest source range one segment may claim
	maxPlainBytes = 256 << 20 // largest plaintext after redaction, before compression
	maxRecipients = 16        // recipient fingerprints one segment may declare
)

var (
	agentRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	projectRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	sessionRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	hex64Re   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hex16Re   = regexp.MustCompile(`^[0-9a-f]{16}$`)
	remoteRe  = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,80}$`)
	idRe      = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// Meta is everything the server knows about a segment; the content is ciphertext.
type Meta struct {
	Agent      string `json:"agent"`
	Project    string `json:"project"`
	SessionID  string `json:"session_id"`
	Kind       string `json:"kind"`
	Relpath    string `json:"relpath"`
	FP         string `json:"fp"`
	SrcSHA256  string `json:"src_sha256"`
	Codec      string `json:"codec"`
	Recipients string `json:"recipients"`
	SrcStart   int64  `json:"src_start"`
	SrcEnd     int64  `json:"src_end"`
	PlainBytes int64  `json:"plain_bytes"`
}

// Validate checks every field that reaches a path or a query.
func (m Meta) Validate() error {
	bad := func(f string) error { return fmt.Errorf("%w: %s", ErrBadInput, f) }
	switch {
	case !agentRe.MatchString(m.Agent):
		return bad("agent")
	case !projectRe.MatchString(m.Project):
		return bad("project")
	case !sessionRe.MatchString(m.SessionID):
		return bad("session")
	case m.Kind != "transcript" && m.Kind != "sidecar":
		return bad("kind")
	case m.Kind == "transcript" && m.Relpath != "":
		return bad("relpath")
	case m.Kind == "sidecar" && !relpathOK(m.Relpath):
		return bad("relpath")
	case !hex64Re.MatchString(m.FP):
		return bad("fp")
	case !hex64Re.MatchString(m.SrcSHA256):
		return bad("src_sha256")
	case m.SrcStart < 0 || m.SrcStart >= m.SrcEnd || m.SrcEnd-m.SrcStart > maxSrcSpan:
		return bad("range")
	case m.Codec != "zstd" && m.Codec != "br":
		return bad("codec")
	case m.PlainBytes < 0 || m.PlainBytes > maxPlainBytes:
		return bad("plain_bytes")
	}
	if _, err := normRecipients(m.Recipients); err != nil {
		return err
	}
	return nil
}

// ValidProject reports whether s is an acceptable project name (the only free text the server stores besides paths).
func ValidProject(s string) bool { return projectRe.MatchString(s) }

func relpathOK(p string) bool {
	if p == "" || len(p) > 200 || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) || strings.Contains(p, ":") || strings.Contains(p, "\x00") {
		return false
	}
	for _, part := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return false
		}
	}
	return true
}

// normRecipients sorts a comma-joined list of 16-hex fingerprints; empty stays empty.
func normRecipients(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	parts := strings.Split(s, ",")
	if len(parts) > maxRecipients {
		return "", fmt.Errorf("%w: recipients", ErrBadInput)
	}
	for _, p := range parts {
		if !hex16Re.MatchString(p) {
			return "", fmt.Errorf("%w: recipients", ErrBadInput)
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, ","), nil
}

// SegmentID is hex(sha256(agent \0 session \0 kind \0 relpath \0 fp \0 start \0 end))[:32]. The PC computes the same.
func SegmentID(m Meta) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{m.Agent, m.SessionID, m.Kind, m.Relpath, m.FP, strconv.FormatInt(m.SrcStart, 10), strconv.FormatInt(m.SrcEnd, 10)}, "\x00")))
	return hex.EncodeToString(sum[:])[:32]
}
