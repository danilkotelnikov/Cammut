// Package archiveapi is the REST surface of the blind archive under /v1/archive/. Every route needs an archive/<op>
// scope; the hook token gets put and verify only, reading ciphertext back is a separate token.
package archiveapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"cammut/internal/acl"
	"cammut/internal/archive"
	"cammut/internal/gateway"
	"cammut/internal/store"
)

// MaxSegment is the hard limit on one uploaded ciphertext segment.
const MaxSegment = 4 << 20

// maxMetaHeader bounds X-Archive-Meta and X-Archive-Recipients: real metadata is under 1 KiB, and anything larger would
// only be a way to park text in the database outside the archive quota.
const maxMetaHeader = 4096

// maxNote bounds an audit note. It is a project name (64 characters at most) or empty.
const maxNote = 64

type api struct {
	a   *archive.Store
	st  *store.Store
	log *slog.Logger
	now func() time.Time
}

// New returns the handler to mount as gateway.Deps.Archive.
func New(a *archive.Store, st *store.Store, log *slog.Logger) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	x := &api{a: a, st: st, log: log, now: time.Now}
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/archive/segments/{id}", x.put)
	mux.HandleFunc("GET /v1/archive/segments/{id}", x.segment) // also answers HEAD
	mux.HandleFunc("GET /v1/archive/sessions/{agent}/{session}/coverage", x.coverage)
	mux.HandleFunc("GET /v1/archive/segments", x.list)
	mux.HandleFunc("GET /v1/archive/status", x.status)
	return mux
}

// gate checks the scope and starts the audit row; the returned function writes it. note is a project name or empty.
func (x *api) gate(w http.ResponseWriter, r *http.Request, op string) (store.Token, func(ok bool, note string), bool) {
	w.Header().Set("Cache-Control", "no-store")
	tok, ok := gateway.TokenFrom(r.Context())
	if !ok || !acl.Allowed(tok.Scopes, "archive", op) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return tok, nil, false
	}
	start := x.now()
	return tok, func(ok bool, note string) {
		if len(note) > maxNote {
			note = strings.ToValidUTF8(note[:maxNote], "")
		}
		a := store.Audit{TS: start, TokenID: tok.ID, Upstream: "archive", Tool: op, OK: ok, Millis: x.now().Sub(start).Milliseconds(), Note: note, IP: r.Header.Get("X-Cammut-Client-IP")}
		if err := x.st.AddAudit(a); err != nil {
			x.log.Error("audit write failed", "err", err)
		}
	}, true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func b64(m archive.Meta) string {
	b, _ := json.Marshal(m)
	return base64.RawURLEncoding.EncodeToString(b)
}

func unb64(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}

func (x *api) put(w http.ResponseWriter, r *http.Request) {
	tok, done, ok := x.gate(w, r, "put")
	if !ok {
		return
	}
	project := ""
	fail := func(code int, msg string) {
		done(false, project)
		writeJSON(w, code, map[string]string{"error": msg})
	}
	hm, hr := r.Header.Get("X-Archive-Meta"), r.Header.Get("X-Archive-Recipients")
	if len(hm) > maxMetaHeader || len(hr) > maxMetaHeader {
		fail(http.StatusBadRequest, "bad_meta")
		return
	}
	raw, err := unb64(hm)
	var m archive.Meta
	if err != nil || json.Unmarshal(raw, &m) != nil {
		fail(http.StatusBadRequest, "bad_meta")
		return
	}
	if hr != "" {
		m.Recipients = hr
	}
	// only a validated project may reach the audit row: it lives in cammut.db, outside the archive quota
	if err := m.Validate(); err != nil {
		fail(http.StatusBadRequest, "bad_input")
		return
	}
	project = m.Project
	if r.ContentLength > MaxSegment {
		fail(http.StatusRequestEntityTooLarge, "too_large")
		return
	}
	res, err := x.a.Put(r.Context(), r.PathValue("id"), m, r.Header.Get("X-Content-SHA256"), r.Body, MaxSegment, tok.ID)
	switch {
	case errors.Is(err, archive.ErrContentMismatch):
		fail(http.StatusConflict, "content_mismatch")
	case errors.Is(err, archive.ErrBadInput):
		fail(http.StatusBadRequest, "bad_input")
	case errors.Is(err, archive.ErrNotAge):
		fail(http.StatusUnsupportedMediaType, "not_age")
	case errors.Is(err, archive.ErrTooLarge):
		fail(http.StatusRequestEntityTooLarge, "too_large")
	case errors.Is(err, archive.ErrQuota):
		fail(http.StatusInsufficientStorage, "quota")
	case errors.Is(err, archive.ErrBusy):
		w.Header().Set("Retry-After", "5")
		fail(http.StatusServiceUnavailable, "busy")
	case err != nil:
		x.log.Error("archive put", "err", err.Error())
		fail(http.StatusInternalServerError, "internal")
	default:
		done(true, project)
		code := http.StatusOK
		if res.Created {
			code = http.StatusCreated
		}
		writeJSON(w, code, map[string]any{"id": r.PathValue("id"), "created": res.Created, "sha256": res.SHA, "bytes": res.Bytes, "matches": res.Matches, "recipients_changed": res.RecipientsChanged})
	}
}

func (x *api) segment(w http.ResponseWriter, r *http.Request) {
	op := "get"
	if r.Method == http.MethodHead {
		op = "verify"
	}
	_, done, ok := x.gate(w, r, op)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if op == "verify" {
		g, found, err := x.a.Head(id)
		if err != nil || !found {
			done(false, "")
			code := http.StatusNotFound
			if err != nil {
				code = http.StatusInternalServerError
			}
			w.WriteHeader(code)
			return
		}
		done(true, g.Project)
		w.Header().Set("X-Content-SHA256", g.SHA)
		w.Header().Set("Content-Length", strconv.FormatInt(g.CipherBytes, 10))
		w.Header().Set("X-Archive-Stored-At", g.StoredAt.UTC().Format(time.RFC3339))
		w.WriteHeader(http.StatusOK)
		return
	}
	rc, g, err := x.a.Open(id)
	if err != nil {
		done(false, "")
		code := http.StatusNotFound
		if !errors.Is(err, archive.ErrNotFound) {
			code = http.StatusInternalServerError
		}
		http.Error(w, "not found", code)
		return
	}
	defer rc.Close()
	done(true, g.Project)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-SHA256", g.SHA)
	w.Header().Set("X-Archive-Meta", b64(g.Meta))
	w.Header().Set("Content-Length", strconv.FormatInt(g.CipherBytes, 10))
	_, _ = io.CopyBuffer(w, rc, make([]byte, 32<<10))
}

type segRef struct {
	ID         string `json:"id"`
	Start      int64  `json:"start"`
	End        int64  `json:"end"`
	SrcSHA256  string `json:"src_sha256"`
	SHA256     string `json:"sha256"`
	Replicated bool   `json:"replicated"`
	// Recipients are the fingerprints the uploader declared for this segment (sorted; [] when none). The server cannot
	// verify them: it holds no key and cannot read the age header's recipient stanzas.
	Recipients []string `json:"recipients"`
}

func (x *api) coverage(w http.ResponseWriter, r *http.Request) {
	_, done, ok := x.gate(w, r, "verify")
	if !ok {
		return
	}
	agent, session := r.PathValue("agent"), r.PathValue("session")
	if len(agent) > 32 || len(session) > 80 {
		done(false, "")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_input"})
		return
	}
	c, err := x.a.Coverage(agent, session)
	if err != nil {
		done(false, "")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	segs := make([]segRef, 0, len(c.Segs))
	for _, s := range c.Segs {
		segs = append(segs, segRef{s.ID, s.Start, s.End, s.SrcSHA256, s.SHA256, s.Replicated, s.Recipients})
	}
	done(true, "")
	writeJSON(w, http.StatusOK, map[string]any{"fp": c.FP, "ranges": c.Ranges, "contiguous_to": c.ContiguousTo, "segments": c.Segments, "segs": segs})
}

func (x *api) list(w http.ResponseWriter, r *http.Request) {
	_, done, ok := x.gate(w, r, "list")
	if !ok {
		return
	}
	q := r.URL.Query()
	f := archive.ListFilter{Project: q.Get("project"), Agent: q.Get("agent"), SessionID: q.Get("session"), Cursor: q.Get("cursor")}
	if f.Project != "" && !archive.ValidProject(f.Project) {
		done(false, "")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_input"})
		return
	}
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	if v := q.Get("since"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			f.Since = t
		} else if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			f.Since = time.Unix(n, 0)
		}
	}
	segs, next, err := x.a.ListPage(f)
	if errors.Is(err, archive.ErrBadInput) {
		done(false, "")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_input"})
		return
	}
	if err != nil {
		done(false, "")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	type row struct {
		ID          string   `json:"id"`
		Agent       string   `json:"agent"`
		Project     string   `json:"project"`
		SessionID   string   `json:"session_id"`
		Kind        string   `json:"kind"`
		Relpath     string   `json:"relpath"`
		FP          string   `json:"fp"`
		SrcStart    int64    `json:"src_start"`
		SrcEnd      int64    `json:"src_end"`
		Codec       string   `json:"codec"`
		PlainBytes  int64    `json:"plain_bytes"`
		CipherBytes int64    `json:"cipher_bytes"`
		SHA256      string   `json:"sha256"`
		StoredAt    int64    `json:"stored_at"`
		Recipients  []string `json:"recipients"`
	}
	rows := make([]row, 0, len(segs))
	for _, s := range segs {
		rows = append(rows, row{s.ID, s.Agent, s.Project, s.SessionID, s.Kind, s.Relpath, s.FP, s.SrcStart, s.SrcEnd, s.Codec, s.PlainBytes, s.CipherBytes, s.SHA, s.StoredAt.Unix(), recipientList(s.Recipients)})
	}
	done(true, f.Project)
	// next_cursor is null when the listing is complete; otherwise pass it as ?cursor= to get the next page
	var nextCursor any
	if next != "" {
		nextCursor = next
	}
	writeJSON(w, http.StatusOK, map[string]any{"segments": rows, "truncated": next != "", "next_cursor": nextCursor})
}

func (x *api) status(w http.ResponseWriter, r *http.Request) {
	_, done, ok := x.gate(w, r, "list")
	if !ok {
		return
	}
	st, err1 := x.a.Stats()
	rs, err2 := x.a.ReplicaStatus()
	pins, err3 := x.a.RecipientPins()
	if err1 != nil || err2 != nil || err3 != nil {
		done(false, "")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	var last any
	if !rs.LastRunAt.IsZero() {
		last = rs.LastRunAt.UTC().Format(time.RFC3339)
	}
	changes := []map[string]any{}
	for _, p := range pins {
		if p.Changed {
			changes = append(changes, map[string]any{"project": p.Project, "pinned": p.Fingerprints, "now": p.LastChangedTo, "changed_at": p.ChangedAt.UTC().Format(time.RFC3339)})
		}
	}
	done(true, "")
	writeJSON(w, http.StatusOK, map[string]any{
		"segments": st.Segments, "cipher_bytes": st.CipherBytes, "sessions": st.Sessions, "by_project": st.ByProject,
		"free_bytes": st.FreeBytes, "max_bytes": x.a.MaxBytes(),
		"replica": map[string]any{
			"last_run_at": last, "replicated": rs.Replicated, "unreplicated": rs.Unreplicated,
			"oldest_unreplicated_age_s": int64(rs.OldestUnreplicatedAge.Seconds()),
		},
		"recipient_changes": changes,
	})
}

// recipientList turns the stored "a,b" form into the JSON array; it is never null.
func recipientList(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, ",")
}
