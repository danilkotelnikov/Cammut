// Package memoryapi is the REST surface of the note store under /v1/memory/. Every route needs a memory/<op> scope:
// brief, recall or remember. Bodies are at most 64 KiB, unknown fields are refused, nothing is cached.
package memoryapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"cammut/internal/acl"
	"cammut/internal/gateway"
	"cammut/internal/memory"
)

const maxBody = 64 << 10

var sessionRe = regexp.MustCompile(`^[A-Za-z0-9._:-]{0,100}$`)

type api struct {
	svc *memory.Service
	log *slog.Logger
}

// New returns the handler to mount as gateway.Deps.Memory.
func New(svc *memory.Service, log *slog.Logger) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	a := &api{svc: svc, log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/memory/brief", a.brief)
	mux.HandleFunc("GET /v1/memory/projects", a.projects)
	mux.HandleFunc("GET /v1/memory/status", a.status)
	mux.HandleFunc("GET /v1/memory/notes", a.list)
	mux.HandleFunc("GET /v1/memory/history", a.history)
	mux.HandleFunc("POST /v1/memory/notes", a.create)
	mux.HandleFunc("PATCH /v1/memory/notes/{id}", a.patch)
	mux.HandleFunc("POST /v1/memory/recall", a.recall)
	mux.HandleFunc("POST /v1/memory/confirm", a.confirm)
	mux.HandleFunc("POST /v1/memory/handoff", a.handoff)
	mux.HandleFunc("GET /v1/memory/checkpoints", a.checkpointRead)
	mux.HandleFunc("POST /v1/memory/checkpoints", a.checkpointWrite)
	return mux
}

// gate checks the scope for op (brief, recall or remember) and builds the actor.
func (a *api) gate(w http.ResponseWriter, r *http.Request, op string) (memory.Actor, bool) {
	w.Header().Set("Cache-Control", "no-store")
	tok, ok := gateway.TokenFrom(r.Context())
	if !ok || !acl.Allowed(tok.Scopes, "memory", op) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return memory.Actor{}, false
	}
	return memory.Actor{Agent: "rest:" + tok.Label, TokenLabel: tok.Label, TokenID: tok.ID, IP: r.Header.Get("X-Cammut-Client-IP"),
		CanObserve: acl.Allowed(tok.Scopes, "memory", "observe")}, true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *api) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, memory.ErrBadInput):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": strings.TrimPrefix(err.Error(), "bad input: ")})
	case errors.Is(err, memory.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": strings.TrimPrefix(err.Error(), "not found: ")})
	case errors.Is(err, memory.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "checkpoint revision conflict"})
	default:
		a.log.Error("memory api", "err", err.Error())
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
	}
}

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

// decode reads exactly one JSON object of at most 64 KiB with no unknown fields and nothing after it.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if err == nil {
		if _, e := dec.Token(); e != io.EOF {
			err = errors.New("unexpected data after the JSON object")
		}
	}
	if err == nil {
		return true
	}
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request too large"})
	} else {
		badRequest(w, "invalid JSON: "+err.Error())
	}
	return false
}

func session(r *http.Request) (string, bool) {
	s := r.URL.Query().Get("session")
	if s == "" {
		s = r.Header.Get("X-Memory-Session")
	}
	return s, sessionRe.MatchString(s)
}

func (a *api) brief(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "brief")
	if !ok {
		return
	}
	q := r.URL.Query()
	req := memory.BriefRequest{Tier: q.Get("tier"), Section: q.Get("section"), Page: q.Get("page")}
	if s := q.Get("since_version"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			badRequest(w, "since_version must be a non-negative integer")
			return
		}
		req.SinceVersion = n
	}
	var good bool
	if act.Session, good = session(r); !good {
		badRequest(w, "session must match "+sessionRe.String())
		return
	}
	v, err := a.svc.Brief(r.Context(), act, q.Get("project"), req)
	if err != nil {
		a.fail(w, err)
		return
	}
	if q.Get("format") == "md" {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = io.WriteString(w, v.Body)
		return
	}
	if v.IsDelta {
		ops := v.Delta
		if ops == nil {
			ops = []memory.Op{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"project": v.Project, "version": v.Version, "delta": true, "ops": ops, "stale": v.Stale, "tier": v.Tier, "generated_at": v.GeneratedAt})
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *api) projects(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "brief")
	if !ok {
		return
	}
	ps, err := a.svc.Projects(act)
	if err != nil {
		a.fail(w, err)
		return
	}
	type row struct {
		Name         string    `json:"name"`
		Notes        int       `json:"notes"`
		LastActivity time.Time `json:"last_activity"`
		BriefVersion int       `json:"brief_version"`
	}
	out := make([]row, 0, len(ps))
	for _, p := range ps {
		out = append(out, row{p.Name, p.Notes, p.LastActivity, p.BriefVersion})
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

func (a *api) status(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "brief")
	if !ok {
		return
	}
	v, err := a.svc.Status(act, r.URL.Query().Get("project"))
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (a *api) list(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "recall")
	if !ok {
		return
	}
	q := r.URL.Query()
	f := memory.NoteFilter{Project: q.Get("project"), Kind: q.Get("kind"), Status: q.Get("status"), Query: q.Get("q"), Limit: 50,
		NoSpeculative: q.Get("include_speculative") != "true"} // guesses are listed only when asked for
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 200 {
			badRequest(w, "limit must be 1-200")
			return
		}
		f.Limit = n
	}
	if s := q.Get("since"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			badRequest(w, "since must be RFC 3339")
			return
		}
		f.Since = t
	}
	notes, err := a.svc.Notes(act, f)
	if err != nil {
		a.fail(w, err)
		return
	}
	out := make([]memory.NoteView, 0, len(notes))
	for _, n := range notes {
		out = append(out, memory.ViewOf(n, "", nil))
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": out})
}

func (a *api) create(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "remember")
	if !ok {
		return
	}
	var in struct {
		Project    string   `json:"project"`
		Kind       string   `json:"kind"`
		Title      string   `json:"title"`
		Body       string   `json:"body"`
		Gist       string   `json:"gist"`
		Tags       []string `json:"tags"`
		Importance int      `json:"importance"`
		TaskStatus string   `json:"task_status"`
		Supersedes string   `json:"supersedes"`
		Key        string   `json:"key"`
		Epistemic  string   `json:"epistemic"`
		Force      bool     `json:"force"`
	}
	if !decode(w, r, &in) {
		return
	}
	out, err := a.svc.RememberFull(r.Context(), act, memory.Note{Project: in.Project, Kind: in.Kind, Title: in.Title, Body: in.Body, Gist: in.Gist, Tags: in.Tags,
		Importance: in.Importance, TaskStatus: in.TaskStatus, Supersedes: in.Supersedes, Key: in.Key, Epistemic: in.Epistemic}, memory.RememberOpts{Force: in.Force})
	if err != nil {
		a.fail(w, err)
		return
	}
	code := http.StatusCreated
	if out.Duplicate != nil {
		code = http.StatusOK
	}
	writeJSON(w, code, out.Response())
}

// confirm upgrades a note's epistemic status; observed needs the memory/observe scope.
func (a *api) confirm(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "remember")
	if !ok {
		return
	}
	var in struct {
		ID        string `json:"id"`
		Epistemic string `json:"epistemic"`
	}
	if !decode(w, r, &in) {
		return
	}
	n, err := a.svc.ConfirmNote(r.Context(), act, in.ID, in.Epistemic)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, memory.ViewOf(n, "", nil))
}

// history lists every version of a keyed note, newest first.
func (a *api) history(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "recall")
	if !ok {
		return
	}
	q := r.URL.Query()
	notes, err := a.svc.History(r.Context(), act, q.Get("project"), q.Get("key"))
	if err != nil {
		a.fail(w, err)
		return
	}
	out := make([]memory.NoteView, 0, len(notes))
	for _, n := range notes {
		out = append(out, memory.ViewOf(n, "", nil))
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": out})
}

func (a *api) patch(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "remember")
	if !ok {
		return
	}
	var in struct {
		Status     *string   `json:"status"`
		Title      *string   `json:"title"`
		Body       *string   `json:"body"`
		Tags       *[]string `json:"tags"`
		Importance *int      `json:"importance"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Status != nil && *in.Status != "retracted" && *in.Status != "active" {
		badRequest(w, "status can only be set to retracted or active; superseded and expired are set by the system")
		return
	}
	if err := a.svc.Patch(r.Context(), act, r.PathValue("id"), memory.NotePatch{Status: in.Status, Title: in.Title, Body: in.Body, Tags: in.Tags, Importance: in.Importance}); err != nil {
		a.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) recall(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "recall")
	if !ok {
		return
	}
	var in struct {
		Query   string   `json:"query"`
		Refs    []string `json:"refs"`
		Pages   []string `json:"pages"`
		Project string   `json:"project"`
		Kinds   []string `json:"kinds"`
		Limit   int      `json:"limit"`
		Since   string   `json:"since"`

		IncludeSpeculative bool `json:"include_speculative"`
	}
	if !decode(w, r, &in) {
		return
	}
	q := memory.RecallQuery{Project: in.Project, Query: in.Query, Refs: in.Refs, Pages: in.Pages, Kinds: in.Kinds, Limit: in.Limit, IncludeSpeculative: in.IncludeSpeculative}
	if in.Since != "" {
		t, err := time.Parse(time.RFC3339, in.Since)
		if err != nil {
			badRequest(w, "since must be RFC 3339")
			return
		}
		q.Since = t
	}
	var good bool
	if act.Session, good = session(r); !good {
		badRequest(w, "session must match "+sessionRe.String())
		return
	}
	res, err := a.svc.RecallResult(r.Context(), act, q)
	if err != nil {
		a.fail(w, err)
		return
	}
	out := make([]memory.NoteView, 0, len(res.Hits))
	for _, h := range res.Hits {
		sc := h.Score
		out = append(out, memory.ViewOf(h.Note, h.Ref, &sc))
	}
	body := map[string]any{"notes": out}
	if res.Abstained != "" {
		body["abstained"] = res.Abstained // "below_threshold": nothing relevant, said honestly
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *api) handoff(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "remember")
	if !ok {
		return
	}
	var in struct {
		Project   string   `json:"project"`
		Agent     string   `json:"agent"`
		Summary   string   `json:"summary"`
		OpenTasks []string `json:"open_tasks"`
		NextSteps []string `json:"next_steps"`
	}
	if !decode(w, r, &in) {
		return
	}
	n, err := a.svc.Handoff(r.Context(), act, memory.HandoffIn{Project: in.Project, Agent: in.Agent, Summary: in.Summary, OpenTasks: in.OpenTasks, NextSteps: in.NextSteps})
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": n.ID, "project": n.Project, "title": n.Title})
}

func (a *api) checkpointWrite(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "remember")
	if !ok {
		return
	}
	var in memory.Checkpoint
	if !decode(w, r, &in) {
		return
	}
	cp, duplicate, err := a.svc.Checkpoint(act, in)
	if err != nil {
		a.fail(w, err)
		return
	}
	status := http.StatusCreated
	if duplicate {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"checkpoint": cp, "state": "server_durable", "duplicate": duplicate})
}

func (a *api) checkpointRead(w http.ResponseWriter, r *http.Request) {
	act, ok := a.gate(w, r, "brief")
	if !ok {
		return
	}
	projectID, workspaceID := r.URL.Query().Get("project_id"), r.URL.Query().Get("workspace_id")
	if !memory.ValidCheckpointScope(projectID, workspaceID) {
		badRequest(w, "project_id and workspace_id must be opaque identifiers")
		return
	}
	cp, found, err := a.svc.CurrentCheckpoint(act, projectID, workspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !found {
		a.fail(w, memory.ErrNotFound)
		return
	}
	// Serving bytes is not evidence that a client emitted, consumed or confirmed them.
	writeJSON(w, http.StatusOK, map[string]any{"checkpoint": cp})
}
