package memory

import "time"

// NoteView is how a note is shown to API and tool callers.
type NoteView struct {
	ID         string    `json:"id"`
	Ref        string    `json:"ref,omitempty"`
	Project    string    `json:"project"`
	Kind       string    `json:"kind"`
	Key        string    `json:"key,omitempty"`
	Epistemic  string    `json:"epistemic"`
	Title      string    `json:"title"`
	Body       string    `json:"body"`
	Gist       string    `json:"gist,omitempty"`
	Tags       []string  `json:"tags"`
	Status     string    `json:"status"`
	TaskStatus string    `json:"task_status,omitempty"`
	Importance int       `json:"importance"`
	Confidence float64   `json:"confidence"`
	Agent      string    `json:"source_agent"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	Supersedes string    `json:"supersedes,omitempty"`
	SupersedBy string    `json:"superseded_by,omitempty"`
	Score      *float64  `json:"score,omitempty"`
}

// ViewOf converts a note; ref and score are optional.
func ViewOf(n Note, ref string, score *float64) NoteView {
	return NoteView{ID: n.ID, Ref: ref, Project: n.Project, Kind: n.Kind, Key: n.Key, Epistemic: n.Epistemic, Title: n.Title, Body: n.Body, Gist: n.Gist, Tags: n.Tags, Status: n.Status,
		TaskStatus: n.TaskStatus, Importance: n.Importance, Confidence: n.Confidence, Agent: n.SourceAgent, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt,
		Supersedes: n.Supersedes, SupersedBy: n.SupersededBy, Score: score}
}

// Response is the answer to a remember call, shared by REST and MCP. A duplicate is not an error: stored is false and
// duplicate_of names the note that already says it. A stored note may carry possible_supersedes, up to three older
// notes of the same project, kind and agent that it may replace; they are also queued for a person to review.
func (o RememberOutcome) Response() map[string]any {
	if o.Duplicate != nil {
		return map[string]any{"stored": false, "duplicate_of": o.Duplicate.ID, "duplicate_title": o.Duplicate.Title,
			"hint": "this note is almost identical to an existing one; pass force=true to store it anyway, or supersedes=<id> / key to replace one"}
	}
	n := o.Note
	m := map[string]any{"id": n.ID, "project": n.Project, "kind": n.Kind, "title": n.Title, "key": n.Key, "epistemic": n.Epistemic}
	if len(o.PossibleSupersedes) > 0 {
		ps := make([]map[string]any, 0, len(o.PossibleSupersedes))
		for _, s := range o.PossibleSupersedes {
			ps = append(ps, map[string]any{"id": s.Note.ID, "title": s.Note.Title, "cosine": s.Cosine})
		}
		m["possible_supersedes"] = ps
	}
	return m
}
