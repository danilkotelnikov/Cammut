package memory

import (
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// ErrConflict marks a causal or idempotency collision; the REST layer maps it to HTTP 409.
var ErrConflict = errors.New("conflict")

// checkpointKeep is how many revisions of one workspace stay stored.
const checkpointKeep = 20

// maxCheckpointScopes bounds the distinct project/workspace pairs; a var so a test can use a small cap.
var maxCheckpointScopes = 1000

var (
	projectIDRe   = regexp.MustCompile(`^p_[0-9a-f]{32}$`)
	workspaceIDRe = regexp.MustCompile(`^w_[0-9a-f]{32}$`)
	revisionRe    = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	sessionIDRe   = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,100}$`)
)

// Checkpoint is explicit caller-authored state, separate from inferred long-term notes.
// ParentRevision must name this workspace's current head; SourceRevision is stable across retries.
type Checkpoint struct {
	ProjectID      string   `json:"project_id"`
	WorkspaceID    string   `json:"workspace_id"`
	Project        string   `json:"project"`
	Agent          string   `json:"agent"`
	SessionID      string   `json:"session_id"`
	SourceRevision string   `json:"source_revision"`
	ParentRevision string   `json:"parent_revision"`
	Goal           string   `json:"goal"`
	Decisions      []string `json:"decisions"`
	OpenTasks      []string `json:"open_tasks"`
	NextActions    []string `json:"next_actions"`
	ArtifactRefs   []string `json:"artifact_refs"`
	Validation     []string `json:"validation"`
}

func ValidCheckpointScope(projectID, workspaceID string) bool {
	return projectIDRe.MatchString(projectID) && workspaceIDRe.MatchString(workspaceID)
}

func normalizeCheckpoint(in Checkpoint) (Checkpoint, error) {
	if !ValidCheckpointScope(in.ProjectID, in.WorkspaceID) {
		return Checkpoint{}, bad("project_id and workspace_id must be opaque identifiers")
	}
	if !revisionRe.MatchString(in.SourceRevision) || (in.ParentRevision != "" && !revisionRe.MatchString(in.ParentRevision)) {
		return Checkpoint{}, bad("source_revision or parent_revision is invalid")
	}
	if in.Agent != "claude-code" && in.Agent != "codex" || !sessionIDRe.MatchString(in.SessionID) {
		return Checkpoint{}, bad("agent or native session_id is invalid")
	}
	// Ids are echoed into prompts: anything redaction would change (a token-shaped string) is refused, not stored.
	for _, id := range []string{in.SourceRevision, in.ParentRevision, in.SessionID} {
		if Redact(id) != id {
			return Checkpoint{}, bad("source_revision, parent_revision or session_id looks like a secret")
		}
	}
	if len(in.Project) > 120 || strings.TrimSpace(in.Goal) == "" || runes(in.Goal) > 2000 {
		return Checkpoint{}, bad("project display name or goal is invalid")
	}
	in.Project, in.Goal = Redact(in.Project), Redact(in.Goal)
	for _, list := range []*[]string{&in.Decisions, &in.OpenTasks, &in.NextActions, &in.ArtifactRefs, &in.Validation} {
		if *list == nil || len(*list) > 30 {
			return Checkpoint{}, bad("all checkpoint lists must be present and contain at most 30 items")
		}
		copied := make([]string, len(*list))
		for i, v := range *list {
			if runes(v) > 500 {
				return Checkpoint{}, bad("checkpoint list item exceeds 500 characters")
			}
			copied[i] = Redact(v)
		}
		*list = copied
	}
	return in, nil
}

// PutCheckpoint stores one causal revision. The initial INSERT obtains SQLite's write lock before reading the head.
// Exact retries return the same payload; a revision collision or stale parent cannot alter the head.
func (s *Store) PutCheckpoint(in Checkpoint) (Checkpoint, bool, error) {
	cp, err := normalizeCheckpoint(in)
	if err != nil {
		return Checkpoint{}, false, err
	}
	payload, err := json.Marshal(cp)
	if err != nil {
		return Checkpoint{}, false, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Checkpoint{}, false, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT OR IGNORE INTO mem_checkpoint_heads(project_id,workspace_id,source_revision) VALUES(?,?,'')`,
		cp.ProjectID, cp.WorkspaceID)
	if err != nil {
		return Checkpoint{}, false, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		// A new scope: past the cap, evict the scope whose head was written longest ago (lowest checkpoint rowid).
		var scopes int
		if err := tx.QueryRow(`SELECT count(*) FROM mem_checkpoint_heads`).Scan(&scopes); err != nil {
			return Checkpoint{}, false, err
		}
		for ; scopes > maxCheckpointScopes; scopes-- {
			var p, w string
			if err := tx.QueryRow(`SELECT h.project_id, h.workspace_id FROM mem_checkpoint_heads h
				JOIN mem_checkpoints c ON c.project_id=h.project_id AND c.workspace_id=h.workspace_id AND c.source_revision=h.source_revision
				ORDER BY c.rowid LIMIT 1`).Scan(&p, &w); err != nil {
				break
			}
			if _, err := tx.Exec(`DELETE FROM mem_checkpoints WHERE project_id=? AND workspace_id=?`, p, w); err != nil {
				return Checkpoint{}, false, err
			}
			if _, err := tx.Exec(`DELETE FROM mem_checkpoint_heads WHERE project_id=? AND workspace_id=?`, p, w); err != nil {
				return Checkpoint{}, false, err
			}
		}
	}
	var head string
	if err := tx.QueryRow(`SELECT source_revision FROM mem_checkpoint_heads WHERE project_id=? AND workspace_id=?`,
		cp.ProjectID, cp.WorkspaceID).Scan(&head); err != nil {
		return Checkpoint{}, false, err
	}
	var previous string
	err = tx.QueryRow(`SELECT payload FROM mem_checkpoints WHERE project_id=? AND workspace_id=? AND source_revision=?`,
		cp.ProjectID, cp.WorkspaceID, cp.SourceRevision).Scan(&previous)
	if err == nil {
		if previous != string(payload) {
			return Checkpoint{}, false, ErrConflict
		}
		return cp, true, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, false, err
	}
	if head != cp.ParentRevision {
		return Checkpoint{}, false, ErrConflict
	}
	if _, err := tx.Exec(`INSERT INTO mem_checkpoints(project_id,workspace_id,source_revision,payload,created_at) VALUES(?,?,?,?,?)`,
		cp.ProjectID, cp.WorkspaceID, cp.SourceRevision, string(payload), s.now().Unix()); err != nil {
		return Checkpoint{}, false, err
	}
	if _, err := tx.Exec(`UPDATE mem_checkpoint_heads SET source_revision=? WHERE project_id=? AND workspace_id=?`,
		cp.SourceRevision, cp.ProjectID, cp.WorkspaceID); err != nil {
		return Checkpoint{}, false, err
	}
	// Bounded storage: keep the newest checkpointKeep revisions of this workspace (the head is always the newest).
	if _, err := tx.Exec(`DELETE FROM mem_checkpoints WHERE project_id=? AND workspace_id=? AND rowid NOT IN
		(SELECT rowid FROM mem_checkpoints WHERE project_id=? AND workspace_id=? ORDER BY rowid DESC LIMIT ?)`,
		cp.ProjectID, cp.WorkspaceID, cp.ProjectID, cp.WorkspaceID, checkpointKeep); err != nil {
		return Checkpoint{}, false, err
	}
	return cp, false, tx.Commit()
}

// LatestCheckpoint returns only the authoritative head of the specified project/workspace.
func (s *Store) LatestCheckpoint(projectID, workspaceID string) (Checkpoint, bool, error) {
	if !ValidCheckpointScope(projectID, workspaceID) {
		return Checkpoint{}, false, bad("project_id and workspace_id must be opaque identifiers")
	}
	var payload string
	err := s.db.QueryRow(`SELECT c.payload FROM mem_checkpoint_heads h
		JOIN mem_checkpoints c ON c.project_id=h.project_id AND c.workspace_id=h.workspace_id AND c.source_revision=h.source_revision
		WHERE h.project_id=? AND h.workspace_id=?`, projectID, workspaceID).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, false, nil
	}
	if err != nil {
		return Checkpoint{}, false, err
	}
	var cp Checkpoint
	err = json.Unmarshal([]byte(payload), &cp)
	return cp, err == nil, err
}

// Checkpoint and CurrentCheckpoint retain the same audit conventions as the existing memory API.
func (s *Service) Checkpoint(a Actor, cp Checkpoint) (out Checkpoint, duplicate bool, err error) {
	start := s.now()
	defer func() { s.record(a, "checkpoint", cp.ProjectID, start, err) }()
	return s.st.PutCheckpoint(cp)
}

func (s *Service) CurrentCheckpoint(a Actor, projectID, workspaceID string) (out Checkpoint, ok bool, err error) {
	start := s.now()
	defer func() { s.record(a, "checkpoint_read", projectID, start, err) }()
	return s.st.LatestCheckpoint(projectID, workspaceID)
}
