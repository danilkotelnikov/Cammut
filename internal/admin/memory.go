package admin

import (
	"net/http"
	"strconv"

	"cammut/internal/clientip"
	"cammut/internal/memory"
	"cammut/internal/store"
)

// The console reads the note store and can retract a note; agents create notes through the memory API and tools.

func (h *handler) registerMemory(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/memory/projects", h.authed(h.memProjects))
	mux.HandleFunc("GET /api/v1/memory/notes", h.authed(h.memNotes))
	mux.HandleFunc("GET /api/v1/memory/history", h.authed(h.memHistory))
	mux.HandleFunc("GET /api/v1/memory/review", h.authed(h.memReview))
	mux.HandleFunc("POST /api/v1/memory/review/{id}/{action}", h.guard(h.authed(h.memReviewResolve)))
	mux.HandleFunc("POST /api/v1/memory/notes", h.guard(h.authed(h.memCreate)))
	mux.HandleFunc("POST /api/v1/memory/notes/{id}/confirm", h.guard(h.authed(h.memConfirm)))
	mux.HandleFunc("PATCH /api/v1/memory/notes/{id}", h.guard(h.authed(h.memRetract)))
	mux.HandleFunc("GET /api/v1/memory/brief/{project}", h.authed(h.memBrief))
	mux.HandleFunc("GET /api/v1/memory/status", h.authed(h.memStatus))
}

// memActor is the signed-in person. NoDelivery keeps the delivery record about agents: looking at a brief in the
// console is not sending it to anyone.
func memActor(r *http.Request, u store.User) memory.Actor {
	name := "user:" + u.Username
	return memory.Actor{Agent: name, AuditActor: name, IP: clientip.FromRequest(r), NoDelivery: true, Human: true, CanObserve: true}
}

func (h *handler) memProjects(w http.ResponseWriter, r *http.Request, u store.User) {
	ps, err := h.c.Memory.Projects(memActor(r, u))
	if err != nil {
		h.fail(w, err)
		return
	}
	type row struct {
		Name         string  `json:"name"`
		Notes        int     `json:"notes"`
		LastActivity *string `json:"last_activity"`
		BriefVersion int     `json:"brief_version"`
	}
	out := make([]row, 0, len(ps))
	for _, p := range ps {
		out = append(out, row{p.Name, p.Notes, ts(p.LastActivity), p.BriefVersion})
	}
	writeJSON(w, 200, out)
}

func (h *handler) memNotes(w http.ResponseWriter, r *http.Request, u store.User) {
	q := r.URL.Query()
	f := memory.NoteFilter{Project: q.Get("project"), Kind: q.Get("kind"), Status: q.Get("status"), Query: q.Get("q"), Limit: 100}
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 500 {
			jsonErr(w, 400, "limit must be 1-500")
			return
		}
		f.Limit = n
	}
	notes, err := h.c.Memory.Notes(memActor(r, u), f)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := make([]memory.NoteView, 0, len(notes))
	for _, n := range notes {
		out = append(out, memory.ViewOf(n, "", nil))
	}
	writeJSON(w, 200, out)
}

// memReview lists the pending supersession suggestions: a newer note that may replace an older one. A person decides.
func (h *handler) memReview(w http.ResponseWriter, r *http.Request, u store.User) {
	items, err := h.c.Memory.Reviews(r.Context(), memActor(r, u), r.URL.Query().Get("project"))
	if err != nil {
		h.fail(w, err)
		return
	}
	type row struct {
		ID        int64           `json:"id"`
		Project   string          `json:"project"`
		Cosine    float64         `json:"cosine"`
		Note      memory.NoteView `json:"note"`
		Candidate memory.NoteView `json:"candidate"`
	}
	out := make([]row, 0, len(items))
	for _, it := range items {
		out = append(out, row{it.ID, it.Project, it.Cosine, memory.ViewOf(it.Note, "", nil), memory.ViewOf(it.Candidate, "", nil)})
	}
	writeJSON(w, 200, out)
}

func (h *handler) memReviewResolve(w http.ResponseWriter, r *http.Request, u store.User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	action := r.PathValue("action")
	if err != nil || (action != "apply" && action != "dismiss") {
		jsonErr(w, 404, "not found")
		return
	}
	if err := h.c.Memory.ResolveReview(r.Context(), memActor(r, u), id, action == "apply"); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

// memCreate writes a note as a person: epistemic defaults to observed.
func (h *handler) memCreate(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Project    string   `json:"project"`
		Kind       string   `json:"kind"`
		Key        string   `json:"key"`
		Title      string   `json:"title"`
		Body       string   `json:"body"`
		Tags       []string `json:"tags"`
		Importance int      `json:"importance"`
		Epistemic  string   `json:"epistemic"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	n, err := h.c.Memory.Remember(r.Context(), memActor(r, u), memory.Note{Project: in.Project, Kind: in.Kind, Key: in.Key, Title: in.Title, Body: in.Body,
		Tags: in.Tags, Importance: in.Importance, Epistemic: in.Epistemic})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 201, memory.ViewOf(n, "", nil))
}

func (h *handler) memConfirm(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Epistemic string `json:"epistemic"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	n, err := h.c.Memory.ConfirmNote(r.Context(), memActor(r, u), r.PathValue("id"), in.Epistemic)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 200, memory.ViewOf(n, "", nil))
}

func (h *handler) memHistory(w http.ResponseWriter, r *http.Request, u store.User) {
	q := r.URL.Query()
	notes, err := h.c.Memory.History(r.Context(), memActor(r, u), q.Get("project"), q.Get("key"))
	if err != nil {
		h.fail(w, err)
		return
	}
	out := make([]memory.NoteView, 0, len(notes))
	for _, n := range notes {
		out = append(out, memory.ViewOf(n, "", nil))
	}
	writeJSON(w, 200, out)
}

func (h *handler) memRetract(w http.ResponseWriter, r *http.Request, u store.User) {
	var in struct {
		Status string `json:"status"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Status != "retracted" {
		jsonErr(w, 400, `status must be "retracted"`)
		return
	}
	if err := h.c.Memory.Retract(r.Context(), memActor(r, u), r.PathValue("id")); err != nil {
		h.fail(w, err)
		return
	}
	w.WriteHeader(204)
}

func (h *handler) memBrief(w http.ResponseWriter, r *http.Request, u store.User) {
	v, err := h.c.Memory.Brief(r.Context(), memActor(r, u), r.PathValue("project"), memory.BriefRequest{Tier: r.URL.Query().Get("tier")})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 200, v)
}

func (h *handler) memStatus(w http.ResponseWriter, r *http.Request, u store.User) {
	v, err := h.c.Memory.Status(memActor(r, u), r.URL.Query().Get("project"))
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 200, v)
}

// ArchiveAlerts is what the Memory page says about the raw archive. It is built by the caller (a closure over the
// archive store) so this package does not depend on it.
type ArchiveAlerts struct {
	Segments         int     `json:"segments"`
	RecipientChanges int     `json:"recipient_changes"` // projects whose recipient set differs from the pinned one
	ReplicaLastRunAt *string `json:"replica_last_run_at"`
	ReplicaStale     bool    `json:"replica_stale"`
	Unreplicated     int     `json:"unreplicated"`
}

func (h *handler) archiveAlerts(w http.ResponseWriter, r *http.Request, u store.User) {
	a, err := h.c.ArchiveAlerts()
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, 200, a)
}
