package memory

import (
	"regexp"
	"sort"
	"strings"
	"time"
)

// Write-time supersession candidates. A note written without a key is compared with the same agent's active notes of
// the same project and kind. Very close (cosine >= Duplicate) and not differing in a number: a duplicate, not stored
// unless forced. Close (>= Candidate): stored, and up to three candidates are queued for a person to review. The old
// note is never changed by the system.

// Dedup holds the two cosine thresholds; the zero value means DefaultDedup.
type Dedup struct{ Duplicate, Candidate float64 }

// DefaultDedup is 0.92 for a duplicate and 0.85 for a possible supersession.
var DefaultDedup = Dedup{Duplicate: 0.92, Candidate: 0.85}

func (d Dedup) orDefault() Dedup {
	if d == (Dedup{}) {
		return DefaultDedup
	}
	return d
}

const maxSuggestions = 3

// RememberOpts changes how Remember treats a near-duplicate.
type RememberOpts struct{ Force bool }

// Suggestion is an existing note the new one may replace.
type Suggestion struct {
	Note   Note
	Cosine float64
}

// RememberOutcome is the result of RememberFull: the stored note, or the duplicate that made it refuse to store.
type RememberOutcome struct {
	Note               Note
	Duplicate          *Note
	PossibleSupersedes []Suggestion
}

// ReviewItem is one queued suggestion: Note (new) may replace Candidate (old).
type ReviewItem struct {
	ID        int64
	Project   string
	Note      Note
	Candidate Note
	Cosine    float64
	CreatedAt time.Time
}

var numbersIn = regexp.MustCompile(`\d+(?:\.\d+)*`)

// sameNumbers reports whether two texts contain the same numbers: "version 0.2.0" and "version 0.3.0" are close in
// meaning and different in fact, so they are an update, never a duplicate.
func sameNumbers(a, b string) bool {
	x, y := numbersIn.FindAllString(a, -1), numbersIn.FindAllString(b, -1)
	sort.Strings(x)
	sort.Strings(y)
	return strings.Join(x, " ") == strings.Join(y, " ")
}

// VectorsFor returns the vectors of one agent's active notes of one kind in a project.
func (s *Store) VectorsFor(project, kind, agent string) ([]VecRow, error) {
	rows, err := s.db.Query(`SELECT v.note_id,n.kind,v.model,n.updated_at,v.vec FROM mem_vectors v JOIN mem_notes n ON n.id=v.note_id
		WHERE n.project=? AND n.kind=? AND n.source_agent=? AND n.status='active' AND (n.expires_at IS NULL OR n.expires_at>?)`,
		project, kind, agent, s.now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVecRows(rows)
}

// AddReview queues a suggestion; a pair already queued is left as it is.
func (s *Store) AddReview(project, noteID, candidateID string, cosine float64) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO mem_review(project,note_id,candidate_id,cosine,created_at) VALUES(?,?,?,?,?)`,
		project, noteID, candidateID, cosine, s.now().Unix())
	return err
}

type reviewRow struct {
	id                  int64
	project, note, cand string
	cosine              float64
	status              string
	created             int64
}

func (s *Store) reviewRows(where string, args ...any) ([]reviewRow, error) {
	rows, err := s.db.Query(`SELECT id,project,note_id,candidate_id,cosine,status,created_at FROM mem_review WHERE `+where+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []reviewRow
	for rows.Next() {
		var r reviewRow
		if err := rows.Scan(&r.id, &r.project, &r.note, &r.cand, &r.cosine, &r.status, &r.created); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) pendingReviews(project string) ([]ReviewItem, error) {
	where, args := `status='pending'`, []any{}
	if project != "" {
		where, args = where+` AND project=?`, append(args, project)
	}
	rows, err := s.reviewRows(where, args...)
	if err != nil {
		return nil, err
	}
	out := make([]ReviewItem, 0, len(rows))
	for _, r := range rows {
		n, ok1, err := s.GetNote(r.note)
		if err != nil {
			return nil, err
		}
		c, ok2, err := s.GetNote(r.cand)
		if err != nil {
			return nil, err
		}
		if !ok1 || !ok2 {
			continue
		}
		out = append(out, ReviewItem{ID: r.id, Project: r.project, Note: n, Candidate: c, Cosine: r.cosine, CreatedAt: time.Unix(r.created, 0)})
	}
	return out, nil
}

// resolveReview applies (the candidate is superseded by the new note) or dismisses one pending item.
func (s *Store) resolveReview(id int64, apply bool) (string, error) {
	rows, err := s.reviewRows(`id=? AND status='pending'`, id)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", ErrNotFound
	}
	r := rows[0]
	status := "dismissed"
	if apply {
		if err := s.Supersede(r.cand, r.note); err != nil {
			return "", err
		}
		status = "applied"
	}
	_, err = s.db.Exec(`UPDATE mem_review SET status=?, resolved_at=? WHERE id=?`, status, s.now().Unix(), id)
	return r.project, err
}
