// Package memory is Cammut's note store: typed, deduplicated, redacted notes per project, full-text and vector
// recall, and the exhaustive deterministic brief.
package memory

import (
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	// ErrBadInput marks a validation failure; the API layers map it to 400.
	ErrBadInput = errors.New("bad input")
	// ErrNotFound marks an unknown project, note, ref or page; the API layers map it to 404.
	ErrNotFound = errors.New("not found")
)

func bad(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrBadInput, fmt.Sprintf(format, a...))
}

const (
	maxTitle = 120
	maxBody  = 1500
	maxGist  = 200
	maxTags  = 12
	maxTag   = 32
)

var (
	projectRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	kinds     = map[string]bool{"decision": true, "finding": true, "codemap": true, "howto": true, "error_fix": true, "task": true, "state": true, "preference": true}
	statuses  = map[string]bool{"active": true, "superseded": true, "expired": true, "retracted": true}
	keyRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$`)
	// Epistemic status: observed = a person saw or said it; inferred = an agent concluded it; speculative = a guess.
	epistemics = map[string]bool{"observed": true, "inferred": true, "speculative": true}
)

// Epistemic values. Speculative notes never reach the brief or Hindsight and are recalled only on request.
const (
	Observed    = "observed"
	Inferred    = "inferred"
	Speculative = "speculative"
)

// ValidProject reports whether name is a legal project name.
func ValidProject(name string) bool { return projectRe.MatchString(name) }

// Note is one typed memory. Tags, Gist and SourceRef are optional.
type Note struct {
	ID, Project, Kind, Title, Body string
	Tags                           []string
	Status                         string
	Key                            string // optional stable name; unique among the project's ACTIVE notes (writing it again supersedes)
	Epistemic                      string // observed | inferred | speculative
	Supersedes, SupersededBy       string
	TaskStatus                     string
	Importance                     int
	Confidence                     float64
	Gist                           string
	SourceRef                      []string // archive segment ids that hold the raw behind this note
	SourceAgent                    string
	SourceSession, SourceChunk     string
	CreatedAt, UpdatedAt           time.Time
	LastConfirmedAt                time.Time
	ExpiresAt                      time.Time // zero = never
}

// NotePatch changes the fields that are not nil.
type NotePatch struct {
	Title, Body *string
	Tags        *[]string
	Status      *string
	Importance  *int
}

// NoteFilter selects notes; Status "" means active (and not expired), "any" means every status.
type NoteFilter struct {
	Project, Kind, Status, Query string
	Key                          string
	Since                        time.Time
	NoSpeculative                bool // leave out epistemic=speculative (brief and exports)
	Limit                        int  // 0 = no limit
}

// Scored is a search hit; Score is in (0,1] and larger is better. Ref is filled by the service.
type Scored struct {
	Note
	Score float64
	Ref   string
}

// ProjectRow is one line of the project list; Notes counts active notes.
type ProjectRow struct {
	Name         string
	Notes        int
	LastActivity time.Time
	BriefVersion int
}

// VecRow is a stored note vector with the columns the ranker filters on.
type VecRow struct {
	NoteID, Kind, Model string
	UpdatedAt           time.Time
	Vec                 []float32
}

// Item is one rendered brief line with the note it stands for.
type Item struct {
	Ref     string `json:"ref"`
	NoteID  string `json:"note_id"`
	Kind    string `json:"kind"`
	Section string `json:"section"`
	Mode    string `json:"mode"`
	Line    string `json:"line"`
}

// Brief is a stored, versioned project brief (core and full tier).
type Brief struct {
	Project     string
	Version     int
	Body        string // core tier
	BodyFull    string
	Generator   string
	BodyHash    string
	Tokens      int
	Items       []Item
	GeneratedAt time.Time
	Stale       bool
}

// Store owns the memory tables of cammut.db.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

func NewStore(db *sql.DB, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}
}

func (s *Store) UpsertProject(name, root string) error {
	if !projectRe.MatchString(name) {
		return bad("project name must match %s", projectRe)
	}
	t := s.now().Unix()
	roots := "[]"
	if root != "" {
		b, _ := json.Marshal([]string{root})
		roots = string(b)
	}
	_, err := s.db.Exec(`INSERT INTO mem_projects(name,created_at,last_activity,roots) VALUES(?,?,?,?)
		ON CONFLICT(name) DO UPDATE SET last_activity=excluded.last_activity`, name, t, t, roots)
	return err
}

// HasProject reports whether the project exists.
func (s *Store) HasProject(name string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM mem_projects WHERE name=?`, name).Scan(&n)
	return n > 0, err
}

func (s *Store) Projects() ([]ProjectRow, error) {
	rows, err := s.db.Query(`SELECT p.name, p.last_activity, COALESCE(b.version,0),
		(SELECT count(*) FROM mem_notes n WHERE n.project=p.name AND n.status='active' AND (n.expires_at IS NULL OR n.expires_at>?))
		FROM mem_projects p LEFT JOIN mem_briefs b ON b.project=p.name ORDER BY p.name`, s.now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProjectRow
	for rows.Next() {
		var r ProjectRow
		var la int64
		if err := rows.Scan(&r.Name, &la, &r.BriefVersion, &r.Notes); err != nil {
			return nil, err
		}
		r.LastActivity = time.Unix(la, 0)
		out = append(out, r)
	}
	return out, rows.Err()
}

func runes(s string) int { return utf8.RuneCountInString(s) }

func cleanTitle(s string) string { return strings.Join(strings.Fields(s), " ") }

func validTag(t string) bool {
	if t == "" || runes(t) > maxTag {
		return false
	}
	for _, r := range t {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func checkTags(tags []string) ([]string, error) {
	if len(tags) > maxTags {
		return nil, bad("at most %d tags", maxTags)
	}
	out := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, t := range tags {
		if !validTag(t) {
			return nil, bad("tag %q: 1-%d characters, no whitespace", t, maxTag)
		}
		if !seen[t] {
			seen[t] = true
			out = append(out, Redact(t))
		}
	}
	return out, nil
}

func checkText(title, body string) (string, string, error) {
	title = cleanTitle(title)
	if title == "" || runes(title) > maxTitle {
		return "", "", bad("title must be 1-%d characters", maxTitle)
	}
	if runes(body) > maxBody {
		return "", "", bad("body must be at most %d characters", maxBody)
	}
	return Redact(title), Redact(body), nil
}

// AddNote validates, redacts and stores a note, assigning id and times. The project is created on first use.
func (s *Store) AddNote(n Note) (Note, error) {
	if !projectRe.MatchString(n.Project) {
		return Note{}, bad("project name must match %s", projectRe)
	}
	if !kinds[n.Kind] {
		return Note{}, bad("unknown kind %q", n.Kind)
	}
	var err error
	if n.Title, n.Body, err = checkText(n.Title, n.Body); err != nil {
		return Note{}, err
	}
	if n.Tags, err = checkTags(n.Tags); err != nil {
		return Note{}, err
	}
	if runes(n.Gist) > maxGist {
		return Note{}, bad("gist must be at most %d characters", maxGist)
	}
	n.Gist = cleanTitle(Redact(n.Gist))
	if n.Importance == 0 {
		n.Importance = 3
	}
	if n.Importance < 1 || n.Importance > 5 {
		return Note{}, bad("importance must be 1-5")
	}
	if n.Confidence == 0 {
		n.Confidence = 0.7
	}
	if n.Confidence < 0 || n.Confidence > 1 || math.IsNaN(n.Confidence) {
		return Note{}, bad("confidence must be in (0,1]")
	}
	switch {
	case n.Kind != "task":
		n.TaskStatus = ""
	case n.TaskStatus == "":
		n.TaskStatus = "open"
	case n.TaskStatus != "open" && n.TaskStatus != "done":
		return Note{}, bad("task_status must be open or done")
	}
	if n.Status == "" {
		n.Status = "active"
	}
	if !statuses[n.Status] {
		return Note{}, bad("unknown status %q", n.Status)
	}
	if n.Key != "" && !keyRe.MatchString(n.Key) {
		return Note{}, bad("key must match %s", keyRe)
	}
	if n.Epistemic == "" {
		n.Epistemic = Inferred
	}
	if !epistemics[n.Epistemic] {
		return Note{}, bad("epistemic must be observed, inferred or speculative")
	}
	if err := s.UpsertProject(n.Project, ""); err != nil {
		return Note{}, err
	}
	now := s.now()
	n.ID, n.CreatedAt, n.UpdatedAt, n.LastConfirmedAt = newULID(now), now, now, now
	n.Supersedes, n.SupersededBy = "", ""
	tags, _ := json.Marshal(n.Tags)
	refs, _ := json.Marshal(nonNil(n.SourceRef))
	var exp, task any
	if !n.ExpiresAt.IsZero() {
		exp = n.ExpiresAt.Unix()
	}
	if n.TaskStatus != "" {
		task = n.TaskStatus
	}
	var key any
	if n.Key != "" {
		key = n.Key
	}
	// One transaction: the first statement is the write (see Supersede), so a keyed write retires the previous holder of
	// the key and inserts the new note atomically; two concurrent writers cannot both end up active.
	tx, err := s.db.Begin()
	if err != nil {
		return Note{}, err
	}
	defer tx.Rollback()
	if n.Key != "" && n.Status == "active" {
		var old string
		err := tx.QueryRow(`UPDATE mem_notes SET status='superseded', superseded_by=?, updated_at=? WHERE project=? AND note_key=? AND status='active' RETURNING id`,
			n.ID, now.Unix(), n.Project, n.Key).Scan(&old)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return Note{}, err
		}
		n.Supersedes = old
	}
	var sup any
	if n.Supersedes != "" {
		sup = n.Supersedes
	}
	_, err = tx.Exec(`INSERT INTO mem_notes(id,project,kind,title,body,gist,tags,status,task_status,importance,confidence,
		source_agent,source_session,source_chunk,source_ref,created_at,updated_at,last_confirmed_at,expires_at,note_key,epistemic,supersedes)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		n.ID, n.Project, n.Kind, n.Title, n.Body, n.Gist, string(tags), n.Status, task, n.Importance, n.Confidence,
		n.SourceAgent, n.SourceSession, n.SourceChunk, string(refs), now.Unix(), now.Unix(), now.Unix(), exp, key, n.Epistemic, sup)
	if err != nil {
		return Note{}, keyConflict(err)
	}
	if err := tx.Commit(); err != nil {
		return Note{}, err
	}
	s.touch(n.Project)
	if n.Tags == nil {
		n.Tags = []string{}
	}
	return n, nil
}

// keyConflict turns the unique-index violation on (project, key) into a validation error.
func keyConflict(err error) error {
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") && strings.Contains(err.Error(), "note_key") {
		return bad("another active note already holds this key")
	}
	return err
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (s *Store) touch(project string) {
	_, _ = s.db.Exec(`UPDATE mem_projects SET last_activity=? WHERE name=?`, s.now().Unix(), project)
}

const noteCols = `n.id,n.project,n.kind,n.title,n.body,n.gist,n.tags,n.status,COALESCE(n.supersedes,''),COALESCE(n.superseded_by,''),
	COALESCE(n.task_status,''),n.importance,n.confidence,n.source_agent,n.source_session,n.source_chunk,n.source_ref,
	n.created_at,n.updated_at,n.last_confirmed_at,COALESCE(n.expires_at,0),COALESCE(n.note_key,''),n.epistemic`

type scanner interface{ Scan(...any) error }

func scanNote(r scanner, extra ...any) (Note, error) {
	var n Note
	var tags, refs string
	var c, u, l, e int64
	dst := append([]any{&n.ID, &n.Project, &n.Kind, &n.Title, &n.Body, &n.Gist, &tags, &n.Status, &n.Supersedes, &n.SupersededBy,
		&n.TaskStatus, &n.Importance, &n.Confidence, &n.SourceAgent, &n.SourceSession, &n.SourceChunk, &refs, &c, &u, &l, &e, &n.Key, &n.Epistemic}, extra...)
	if err := r.Scan(dst...); err != nil {
		return Note{}, err
	}
	_ = json.Unmarshal([]byte(tags), &n.Tags)
	_ = json.Unmarshal([]byte(refs), &n.SourceRef)
	if n.Tags == nil {
		n.Tags = []string{}
	}
	n.CreatedAt, n.UpdatedAt, n.LastConfirmedAt = time.Unix(c, 0), time.Unix(u, 0), time.Unix(l, 0)
	if e != 0 {
		n.ExpiresAt = time.Unix(e, 0)
	}
	return n, nil
}

func (s *Store) GetNote(id string) (Note, bool, error) {
	n, err := scanNote(s.db.QueryRow(`SELECT `+noteCols+` FROM mem_notes n WHERE n.id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, false, nil
	}
	return n, err == nil, err
}

// UpdateNote applies a patch; text fields are validated and redacted exactly as in AddNote.
func (s *Store) UpdateNote(id string, p NotePatch) error {
	n, ok, err := s.GetNote(id)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	if p.Title != nil || p.Body != nil {
		t, b := n.Title, n.Body
		if p.Title != nil {
			t = *p.Title
		}
		if p.Body != nil {
			b = *p.Body
		}
		if n.Title, n.Body, err = checkText(t, b); err != nil {
			return err
		}
	}
	if p.Tags != nil {
		if n.Tags, err = checkTags(*p.Tags); err != nil {
			return err
		}
	}
	if p.Status != nil {
		if !statuses[*p.Status] {
			return bad("unknown status %q", *p.Status)
		}
		n.Status = *p.Status
	}
	if p.Importance != nil {
		if *p.Importance < 1 || *p.Importance > 5 {
			return bad("importance must be 1-5")
		}
		n.Importance = *p.Importance
	}
	tags, _ := json.Marshal(n.Tags)
	_, err = s.db.Exec(`UPDATE mem_notes SET title=?,body=?,tags=?,status=?,importance=?,updated_at=? WHERE id=?`,
		n.Title, n.Body, string(tags), n.Status, n.Importance, s.now().Unix(), id)
	if err == nil {
		s.touch(n.Project)
	}
	return keyConflict(err)
}

// Supersede marks oldID superseded by newID. It refuses when oldID is not active or the notes belong to different projects.
func (s *Store) Supersede(oldID, newID string) error {
	if oldID == newID {
		return bad("a note cannot supersede itself")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t := s.now().Unix()
	// The first statement is the write, so the transaction holds the write lock from the start and a concurrent
	// writer cannot invalidate a read snapshot (SQLite would fail such an upgrade at once, not wait).
	res, err := tx.Exec(`UPDATE mem_notes SET status='superseded', superseded_by=?, updated_at=? WHERE id=? AND status='active'
		AND project=(SELECT project FROM mem_notes WHERE id=?)`, newID, t, oldID, newID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var oldProj, oldStatus, newProj string
		if err := tx.QueryRow(`SELECT project,status FROM mem_notes WHERE id=?`, oldID).Scan(&oldProj, &oldStatus); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if err := tx.QueryRow(`SELECT project FROM mem_notes WHERE id=?`, newID).Scan(&newProj); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if oldStatus != "active" {
			return bad("only an active note can be superseded (it is %s)", oldStatus)
		}
		return bad("notes belong to different projects")
	}
	if _, err := tx.Exec(`UPDATE mem_notes SET supersedes=?, updated_at=? WHERE id=?`, oldID, t, newID); err != nil {
		return err
	}
	return tx.Commit()
}

// KeyHistory returns every note that ever held the key in the project, newest first, whatever its status.
func (s *Store) KeyHistory(project, key string) ([]Note, error) {
	rows, err := s.db.Query(`SELECT `+noteCols+` FROM mem_notes n WHERE n.project=? AND n.note_key=? ORDER BY n.seq DESC`, project, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Note
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// SetEpistemic changes a note's epistemic status and records the confirmation.
func (s *Store) SetEpistemic(id, e string) error {
	if !epistemics[e] {
		return bad("epistemic must be observed, inferred or speculative")
	}
	t := s.now().Unix()
	res, err := s.db.Exec(`UPDATE mem_notes SET epistemic=?, last_confirmed_at=?, updated_at=? WHERE id=?`, e, t, t, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Confirm records that a note was seen to still be true.
func (s *Store) Confirm(id string) error {
	res, err := s.db.Exec(`UPDATE mem_notes SET last_confirmed_at=? WHERE id=?`, s.now().Unix(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func statusClause(status string) (string, []any) {
	switch status {
	case "", "active":
		return `n.status='active' AND (n.expires_at IS NULL OR n.expires_at>?)`, nil
	case "any":
		return `1=1`, nil
	}
	return `n.status=?`, []any{status}
}

func (s *Store) ListNotes(f NoteFilter) ([]Note, error) {
	where, args := []string{}, []any{}
	if f.Project != "" {
		where, args = append(where, `n.project=?`), append(args, f.Project)
	}
	if f.Kind != "" {
		where, args = append(where, `n.kind=?`), append(args, f.Kind)
	}
	if f.Key != "" {
		where, args = append(where, `n.note_key=?`), append(args, f.Key)
	}
	if f.NoSpeculative {
		where = append(where, `n.epistemic<>'speculative'`)
	}
	cl, extra := statusClause(f.Status)
	where = append(where, cl)
	if extra != nil {
		args = append(args, extra...)
	} else if f.Status == "" || f.Status == "active" {
		args = append(args, s.now().Unix())
	}
	if !f.Since.IsZero() {
		where, args = append(where, `n.updated_at>=?`), append(args, f.Since.Unix())
	}
	if f.Query != "" {
		q := ftsQuery(f.Query)
		if q == "" {
			return nil, nil
		}
		where, args = append(where, `n.seq IN (SELECT rowid FROM mem_notes_fts WHERE mem_notes_fts MATCH ?)`), append(args, q)
	}
	q := `SELECT ` + noteCols + ` FROM mem_notes n WHERE ` + strings.Join(where, " AND ") + ` ORDER BY n.updated_at DESC, n.id`
	if f.Limit > 0 {
		q += fmt.Sprintf(` LIMIT %d`, f.Limit)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Note
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// A recall body may be 64 KiB: without a cap it would become thousands of OR-ed prefix terms.
const (
	maxFTSTerms     = 12
	maxFTSTermRunes = 40
)

// ftsQuery turns free text into an FTS5 expression: words of two or more characters, each quoted and
// prefix-matched, joined with OR. Text without a single word character gives "" (no match, not an error).
func ftsQuery(q string) string {
	var parts []string
	for _, tok := range strings.Fields(q) {
		hasWord := false
		for _, r := range tok {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				hasWord = true
				break
			}
		}
		if !hasWord || runes(tok) < 2 {
			continue
		}
		if r := []rune(tok); len(r) > maxFTSTermRunes {
			tok = string(r[:maxFTSTermRunes])
		}
		parts = append(parts, `"`+strings.ReplaceAll(tok, `"`, `""`)+`"*`)
		if len(parts) == maxFTSTerms {
			break
		}
	}
	return strings.Join(parts, " OR ")
}

// SearchFTS ranks the project's active notes by bm25 (title weighs most). Score is |bm25|/(1+|bm25|): larger is better.
func (s *Store) SearchFTS(project, query string, kindFilter []string, limit int) ([]Scored, error) {
	q := ftsQuery(query)
	if q == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}
	args := []any{q, project, s.now().Unix()}
	kc := ""
	if len(kindFilter) > 0 {
		kc = ` AND n.kind IN (` + strings.TrimSuffix(strings.Repeat("?,", len(kindFilter)), ",") + `)`
		for _, k := range kindFilter {
			args = append(args, k)
		}
	}
	args = append(args, limit)
	rows, err := s.db.Query(`SELECT `+noteCols+`, bm25(mem_notes_fts, 2.0, 1.0, 0.5) AS rank
		FROM mem_notes_fts JOIN mem_notes n ON n.seq=mem_notes_fts.rowid
		WHERE mem_notes_fts MATCH ? AND n.project=? AND n.status='active' AND (n.expires_at IS NULL OR n.expires_at>?)`+kc+`
		ORDER BY rank LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Scored
	for rows.Next() {
		var rank float64
		n, err := scanNote(rows, &rank)
		if err != nil {
			return nil, err
		}
		a := math.Abs(rank)
		out = append(out, Scored{Note: n, Score: a / (1 + a)})
	}
	return out, rows.Err()
}

func (s *Store) SetVector(noteID, model string, vec []float32) error {
	b := make([]byte, 4*len(vec))
	for i, v := range vec {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(v))
	}
	_, err := s.db.Exec(`INSERT INTO mem_vectors(note_id,model,dim,vec) VALUES(?,?,?,?)
		ON CONFLICT(note_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec`, noteID, model, len(vec), b)
	return err
}

// Vectors returns the vectors of the project's active notes.
func (s *Store) Vectors(project string) ([]VecRow, error) {
	rows, err := s.db.Query(`SELECT v.note_id,n.kind,v.model,n.updated_at,v.vec FROM mem_vectors v JOIN mem_notes n ON n.id=v.note_id
		WHERE n.project=? AND n.status='active' AND (n.expires_at IS NULL OR n.expires_at>?)`, project, s.now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVecRows(rows)
}

func scanVecRows(rows *sql.Rows) ([]VecRow, error) {
	var out []VecRow
	for rows.Next() {
		var r VecRow
		var u int64
		var b []byte
		if err := rows.Scan(&r.NoteID, &r.Kind, &r.Model, &u, &b); err != nil {
			return nil, err
		}
		r.UpdatedAt = time.Unix(u, 0)
		r.Vec = make([]float32, len(b)/4)
		for i := range r.Vec {
			r.Vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetBrief(project string) (Brief, bool, error) {
	var b Brief
	var items string
	var gen int64
	var stale int
	err := s.db.QueryRow(`SELECT project,version,body,body_full,generator,body_hash,tokens,items,generated_at,stale FROM mem_briefs WHERE project=?`, project).
		Scan(&b.Project, &b.Version, &b.Body, &b.BodyFull, &b.Generator, &b.BodyHash, &b.Tokens, &items, &gen, &stale)
	if errors.Is(err, sql.ErrNoRows) {
		return Brief{}, false, nil
	}
	if err != nil {
		return Brief{}, false, err
	}
	_ = json.Unmarshal([]byte(items), &b.Items)
	b.GeneratedAt, b.Stale = time.Unix(gen, 0), stale != 0
	return b, true, nil
}

const briefHistoryKept = 10

// SetBrief stores a brief. The version advances, and the item list is added to the history, only when BodyHash
// differs from the stored one; an identical body just refreshes GeneratedAt and clears Stale.
func (s *Store) SetBrief(b Brief) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Take the write lock before reading (see Supersede).
	if _, err := tx.Exec(`UPDATE mem_briefs SET stale=stale WHERE project=?`, b.Project); err != nil {
		return err
	}
	now := s.now().Unix()
	items, _ := json.Marshal(b.Items)
	var version int
	var hash string
	err = tx.QueryRow(`SELECT version,body_hash FROM mem_briefs WHERE project=?`, b.Project).Scan(&version, &hash)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		version = 0
	case err != nil:
		return err
	case hash == b.BodyHash:
		if _, err := tx.Exec(`UPDATE mem_briefs SET generated_at=?, stale=0 WHERE project=?`, now, b.Project); err != nil {
			return err
		}
		return tx.Commit()
	}
	version++
	if _, err := tx.Exec(`INSERT INTO mem_briefs(project,version,body,body_full,generator,body_hash,tokens,items,generated_at,stale) VALUES(?,?,?,?,?,?,?,?,?,0)
		ON CONFLICT(project) DO UPDATE SET version=excluded.version, body=excluded.body, body_full=excluded.body_full, generator=excluded.generator,
		body_hash=excluded.body_hash, tokens=excluded.tokens, items=excluded.items, generated_at=excluded.generated_at, stale=0`,
		b.Project, version, b.Body, b.BodyFull, b.Generator, b.BodyHash, b.Tokens, string(items), now); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT OR REPLACE INTO mem_brief_hist(project,version,items,created_at) VALUES(?,?,?,?)`, b.Project, version, string(items), now); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM mem_brief_hist WHERE project=? AND version<=?`, b.Project, version-briefHistoryKept); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) MarkBriefStale(project string) error {
	_, err := s.db.Exec(`UPDATE mem_briefs SET stale=1 WHERE project=?`, project)
	return err
}

// BriefHistory returns the item list that was current at a version, if it is still kept (the 10 newest).
func (s *Store) BriefHistory(project string, version int) ([]Item, bool, error) {
	var items string
	err := s.db.QueryRow(`SELECT items FROM mem_brief_hist WHERE project=? AND version=?`, project, version).Scan(&items)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var out []Item
	_ = json.Unmarshal([]byte(items), &out)
	return out, true, nil
}
