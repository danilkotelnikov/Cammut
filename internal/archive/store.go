package archive

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrBadInput        = errors.New("archive: bad input")
	ErrNotAge          = errors.New("archive: body is not an age file")
	ErrTooLarge        = errors.New("archive: segment too large")
	ErrQuota           = errors.New("archive: quota or free space exhausted")
	ErrNotFound        = errors.New("archive: not found")
	ErrContentMismatch = errors.New("archive: id exists with a different plaintext hash")
	ErrBusy            = errors.New("archive: too many uploads in progress")
)

// MaxWriters is how many uploads may stream to temporary files at once; the next one is refused with ErrBusy and
// retried by the client from its outbox.
const MaxWriters = 4

// reserveStep is the granularity in which a streaming upload claims quota and free space.
const reserveStep = 256 << 10

const ageMagic = "age-encryption.org/v1\n"

// Store keeps ciphertext under <dir>/<id[:2]>/<id>.age and its index in the shared SQLite database.
type Store struct {
	db       *sql.DB
	dir      string
	maxBytes int64
	minFree  int64
	now      func() time.Time
	mu       sync.Mutex // ponytail: one writer at a time; uploads are rare and small, shard by id if that ever changes
	rmu      sync.Mutex // guards inflight: bytes of temporary upload files that are not in the index yet
	inflight int64
	writers  chan struct{}
	freeFn   func() (int64, error) // nil: freeBytes of the archive volume; tests replace it
}

func (s *Store) free() (int64, error) {
	if s.freeFn != nil {
		return s.freeFn()
	}
	return s.freeBytes()
}

// New creates the archive directory (0700) and returns the store.
func New(db *sql.DB, dir string, maxBytes, minFree int64, now func() time.Time) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{db: db, dir: dir, maxBytes: maxBytes, minFree: minFree, now: now, writers: make(chan struct{}, MaxWriters)}, nil
}

// PutResult describes one upload. SHA is always the sha256 of the stored (first) copy.
type PutResult struct {
	Created           bool
	SHA               string
	Bytes             int64
	Matches           bool
	RecipientsChanged bool
}

// reservation is quota and free space claimed for the temporary file of one upload; release returns it.
type reservation struct {
	s *Store
	n int64
}

// grow makes the reservation cover at least want bytes. Index rows plus every upload's reservation never exceed the
// quota, and free space minus all reservations never drops below the reserve.
func (r *reservation) grow(want int64) error {
	if want <= r.n {
		return nil
	}
	s := r.s
	need := want - r.n
	take := (need + reserveStep - 1) / reserveStep * reserveStep
	s.rmu.Lock()
	defer s.rmu.Unlock()
	if s.maxBytes > 0 {
		var used int64
		if err := s.db.QueryRow(`SELECT COALESCE(SUM(cipher_bytes),0) FROM arch_segments`).Scan(&used); err != nil {
			return err
		}
		avail := s.maxBytes - used - s.inflight
		if avail < need {
			return ErrQuota
		}
		take = min(take, avail)
	}
	if s.minFree > 0 {
		free, err := s.free()
		if err != nil { // a reserve that cannot be checked is not a reserve: refuse rather than fill the disk
			return ErrQuota
		}
		avail := free - s.inflight - s.minFree
		if avail < need {
			return ErrQuota
		}
		take = min(take, avail)
	}
	s.inflight += take
	r.n += take
	return nil
}

func (r *reservation) release() {
	r.s.rmu.Lock()
	r.s.inflight -= r.n
	r.s.rmu.Unlock()
	r.n = 0
}

// Seg is an index row.
type Seg struct {
	Meta
	ID          string
	CipherBytes int64
	SHA         string
	StoredAt    time.Time
}

func (s *Store) path(id string) string { return filepath.Join(s.dir, id[:2], id+".age") }

// Put stores one ciphertext segment. The body is streamed to a temporary file through a 32 KiB buffer and is never
// held in memory or logged.
func (s *Store) Put(ctx context.Context, id string, m Meta, wantSHA string, body io.Reader, limit int64, tokenID int64) (PutResult, error) {
	if err := m.Validate(); err != nil {
		return PutResult{}, err
	}
	if id != SegmentID(m) || !hex64Re.MatchString(wantSHA) || limit <= 0 {
		return PutResult{}, fmt.Errorf("%w: id or sha", ErrBadInput)
	}
	rec, _ := normRecipients(m.Recipients)
	select {
	case s.writers <- struct{}{}:
		defer func() { <-s.writers }()
	default:
		return PutResult{}, ErrBusy
	}
	res := &reservation{s: s}
	defer res.release()
	sub := filepath.Join(s.dir, id[:2])
	if err := os.MkdirAll(sub, 0o700); err != nil {
		return PutResult{}, err
	}
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	tmp := filepath.Join(sub, id+".age."+hex.EncodeToString(rnd[:])+".tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return PutResult{}, err
	}
	keep := false
	defer func() {
		f.Close()
		if !keep {
			os.Remove(tmp)
		}
	}()
	lr := io.LimitReader(body, limit+1)
	head := make([]byte, len(ageMagic))
	if n, err := io.ReadFull(lr, head); err != nil || string(head[:n]) != ageMagic {
		if err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return PutResult{}, ErrNotAge
		}
		return PutResult{}, err
	}
	h := sha256.New()
	h.Write(head)
	size := int64(len(head))
	if err := res.grow(size); err != nil {
		return PutResult{}, err
	}
	if _, err := f.Write(head); err != nil {
		return PutResult{}, err
	}
	buf := make([]byte, 32<<10)
	for {
		n, rerr := lr.Read(buf)
		if n > 0 {
			if size+int64(n) > limit {
				return PutResult{}, ErrTooLarge
			}
			if err := res.grow(size + int64(n)); err != nil {
				return PutResult{}, err
			}
			if _, err := f.Write(buf[:n]); err != nil {
				return PutResult{}, err
			}
			h.Write(buf[:n])
			size += int64(n)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return PutResult{}, rerr
		}
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != wantSHA {
		return PutResult{}, fmt.Errorf("%w: body sha256 differs from X-Content-SHA256", ErrBadInput)
	}
	if err := f.Sync(); err != nil {
		return PutResult{}, err
	}
	if err := f.Close(); err != nil {
		return PutResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PutResult{}, err
	}
	defer tx.Rollback()
	var oldSHA, oldSrc string
	err = tx.QueryRow(`SELECT sha256, src_sha256 FROM arch_segments WHERE id=?`, id).Scan(&oldSHA, &oldSrc)
	switch {
	case err == nil:
		if oldSrc != m.SrcSHA256 {
			return PutResult{}, ErrContentMismatch
		}
		var cb int64
		_ = tx.QueryRow(`SELECT cipher_bytes FROM arch_segments WHERE id=?`, id).Scan(&cb)
		return PutResult{Created: false, SHA: oldSHA, Bytes: cb, Matches: oldSHA == got}, nil
	case !errors.Is(err, sql.ErrNoRows):
		return PutResult{}, err
	}
	var used int64
	if err := tx.QueryRow(`SELECT COALESCE(SUM(cipher_bytes),0) FROM arch_segments`).Scan(&used); err != nil {
		return PutResult{}, err
	}
	if s.maxBytes > 0 && used+size > s.maxBytes {
		return PutResult{}, ErrQuota
	}
	if s.minFree > 0 {
		if free, err := s.free(); err != nil || free-size < s.minFree {
			return PutResult{}, ErrQuota
		}
	}
	now := s.now().Unix()
	changed, err := pin(tx, m.Project, rec, now)
	if err != nil {
		return PutResult{}, err
	}
	final := s.path(id)
	if err := os.Rename(tmp, final); err != nil {
		return PutResult{}, err
	}
	keep = true
	syncDir(sub)
	var tok any
	if tokenID != 0 {
		tok = tokenID
	}
	if _, err := tx.Exec(`INSERT INTO arch_segments(id,agent,project,session_id,kind,relpath,fp,src_sha256,src_start,src_end,codec,plain_bytes,cipher_bytes,sha256,recipients,stored_at,token_id)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, m.Agent, m.Project, m.SessionID, m.Kind, m.Relpath, m.FP, m.SrcSHA256, m.SrcStart, m.SrcEnd, m.Codec, m.PlainBytes, size, got, rec, now, tok); err != nil {
		os.Remove(final)
		return PutResult{}, err
	}
	if err := tx.Commit(); err != nil {
		os.Remove(final)
		return PutResult{}, err
	}
	return PutResult{Created: true, SHA: got, Bytes: size, Matches: true, RecipientsChanged: changed}, nil
}

// pin records the recipient set first seen for a project and reports whether this upload used a different one.
func pin(tx *sql.Tx, project, rec string, now int64) (bool, error) {
	if rec == "" {
		return false, nil
	}
	var pinned string
	err := tx.QueryRow(`SELECT fingerprints FROM arch_recipient_pins WHERE project=?`, project).Scan(&pinned)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.Exec(`INSERT INTO arch_recipient_pins(project,fingerprints,first_seen_at,last_seen_at) VALUES(?,?,?,?)`, project, rec, now, now)
		return false, err
	}
	if err != nil {
		return false, err
	}
	if pinned == rec {
		_, err = tx.Exec(`UPDATE arch_recipient_pins SET last_seen_at=? WHERE project=?`, now, project)
		return false, err
	}
	_, err = tx.Exec(`UPDATE arch_recipient_pins SET last_seen_at=?, changed=1, last_changed_to=?, changed_at=? WHERE project=?`, now, rec, now, project)
	return true, err
}

func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

const segCols = `id,agent,project,session_id,kind,relpath,fp,src_sha256,src_start,src_end,codec,plain_bytes,cipher_bytes,sha256,recipients,stored_at`

type scanner interface{ Scan(dest ...any) error }

func scanSeg(r scanner) (Seg, error) {
	var g Seg
	var at int64
	err := r.Scan(&g.ID, &g.Agent, &g.Project, &g.SessionID, &g.Kind, &g.Relpath, &g.FP, &g.SrcSHA256, &g.SrcStart, &g.SrcEnd, &g.Codec, &g.PlainBytes, &g.CipherBytes, &g.SHA, &g.Recipients, &at)
	g.StoredAt = time.Unix(at, 0)
	return g, err
}

// Head returns the index row of one segment.
func (s *Store) Head(id string) (Seg, bool, error) {
	if !idRe.MatchString(id) {
		return Seg{}, false, nil
	}
	g, err := scanSeg(s.db.QueryRow(`SELECT `+segCols+` FROM arch_segments WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Seg{}, false, nil
	}
	return g, err == nil, err
}

// Open streams the stored ciphertext.
func (s *Store) Open(id string) (io.ReadCloser, Seg, error) {
	g, ok, err := s.Head(id)
	if err != nil {
		return nil, Seg{}, err
	}
	if !ok {
		return nil, Seg{}, ErrNotFound
	}
	f, err := os.Open(s.path(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, Seg{}, ErrNotFound
		}
		return nil, Seg{}, err
	}
	return f, g, nil
}

// ListFilter narrows List; zero fields match everything.
type ListFilter struct {
	Project, Agent, SessionID string
	Since                     time.Time
	Limit                     int
	Cursor                    string // from a previous ListPage; empty starts at the newest segment
}

// List returns newest first, at most Limit (default 100, cap 1000). Use ListPage to read past the cap.
func (s *Store) List(f ListFilter) ([]Seg, error) {
	segs, _, err := s.ListPage(f)
	return segs, err
}

func encodeCursor(at, rowid int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(at, 10) + ":" + strconv.FormatInt(rowid, 10)))
}

func decodeCursor(c string) (at, rowid int64, err error) {
	raw, derr := base64.RawURLEncoding.DecodeString(c)
	a, b, ok := strings.Cut(string(raw), ":")
	if derr != nil || !ok {
		return 0, 0, fmt.Errorf("%w: cursor", ErrBadInput)
	}
	at, e1 := strconv.ParseInt(a, 10, 64)
	rowid, e2 := strconv.ParseInt(b, 10, 64)
	if e1 != nil || e2 != nil {
		return 0, 0, fmt.Errorf("%w: cursor", ErrBadInput)
	}
	return at, rowid, nil
}

// ListPage is List plus the cursor of the next page: "" means the listing is complete, so a caller can tell a full
// answer from one cut at the cap. Segments stored after the first page was read are not inserted into later pages.
func (s *Store) ListPage(f ListFilter) ([]Seg, string, error) {
	var where []string
	var args []any
	if f.Project != "" {
		where, args = append(where, "project=?"), append(args, f.Project)
	}
	if f.Agent != "" {
		where, args = append(where, "agent=?"), append(args, f.Agent)
	}
	if f.SessionID != "" {
		where, args = append(where, "session_id=?"), append(args, f.SessionID)
	}
	if !f.Since.IsZero() {
		where, args = append(where, "stored_at>=?"), append(args, f.Since.Unix())
	}
	if f.Cursor != "" {
		at, rowid, err := decodeCursor(f.Cursor)
		if err != nil {
			return nil, "", err
		}
		where, args = append(where, "(stored_at<? OR (stored_at=? AND rowid<?))"), append(args, at, at, rowid)
	}
	q := `SELECT ` + segCols + `, rowid FROM arch_segments`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.Query(q+" ORDER BY stored_at DESC, rowid DESC LIMIT ?", append(args, limit+1)...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []Seg
	var rowids []int64
	for rows.Next() {
		var rowid int64
		g, err := scanSeg(rowScan{rows, &rowid})
		if err != nil {
			return nil, "", err
		}
		out, rowids = append(out, g), append(rowids, rowid)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		next = encodeCursor(out[limit-1].StoredAt.Unix(), rowids[limit-1])
	}
	return out, next, nil
}

// rowScan lets scanSeg read a row that carries one extra trailing column.
type rowScan struct {
	r     scanner
	extra *int64
}

func (x rowScan) Scan(dest ...any) error { return x.r.Scan(append(dest, x.extra)...) }

// SegRef is one acknowledged range of the current generation of a transcript.
type SegRef struct {
	ID         string
	Start, End int64
	SrcSHA256  string
	SHA256     string
	Replicated bool
	Recipients []string // fingerprints the uploader declared for this segment, sorted; empty when it declared none
}

func recipientList(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, ",")
}

// Coverage is what the archive holds for the newest file generation of one session transcript.
type Coverage struct {
	FP           string
	Ranges       [][2]int64
	ContiguousTo int64
	Segments     int
	Segs         []SegRef
}

// Coverage merges the stored ranges of the newest generation (by fingerprint). It never claims a byte that no
// stored segment holds: touching or overlapping ranges merge, a gap does not.
func (s *Store) Coverage(agent, session string) (Coverage, error) {
	var c Coverage
	err := s.db.QueryRow(`SELECT fp FROM arch_segments WHERE agent=? AND session_id=? AND kind='transcript' ORDER BY stored_at DESC, rowid DESC LIMIT 1`, agent, session).Scan(&c.FP)
	if errors.Is(err, sql.ErrNoRows) {
		return Coverage{Ranges: [][2]int64{}, Segs: []SegRef{}}, nil
	}
	if err != nil {
		return Coverage{}, err
	}
	rows, err := s.db.Query(`SELECT g.id, g.src_start, g.src_end, g.src_sha256, g.sha256, g.recipients,
  EXISTS(SELECT 1 FROM arch_replicas r WHERE r.segment_id=g.id AND r.replica_sha256=g.sha256)
FROM arch_segments g WHERE g.agent=? AND g.session_id=? AND g.kind='transcript' AND g.fp=? ORDER BY g.src_start, g.src_end, g.id`, agent, session, c.FP)
	if err != nil {
		return Coverage{}, err
	}
	defer rows.Close()
	c.Ranges, c.Segs = [][2]int64{}, []SegRef{}
	for rows.Next() {
		var r SegRef
		var rep int
		var rec string
		if err := rows.Scan(&r.ID, &r.Start, &r.End, &r.SrcSHA256, &r.SHA256, &rec, &rep); err != nil {
			return Coverage{}, err
		}
		r.Replicated, r.Recipients = rep != 0, recipientList(rec)
		c.Segs = append(c.Segs, r)
		if n := len(c.Ranges); n > 0 && r.Start <= c.Ranges[n-1][1] {
			if r.End > c.Ranges[n-1][1] {
				c.Ranges[n-1][1] = r.End
			}
		} else {
			c.Ranges = append(c.Ranges, [2]int64{r.Start, r.End})
		}
	}
	if err := rows.Err(); err != nil {
		return Coverage{}, err
	}
	c.Segments = len(c.Segs)
	if len(c.Ranges) > 0 && c.Ranges[0][0] == 0 {
		c.ContiguousTo = c.Ranges[0][1]
	}
	return c, nil
}

// ReplicatedThrough is the end of the contiguous run, from byte 0, that replicated segments cover.
func ReplicatedThrough(c Coverage) int64 {
	var cur int64
	for _, r := range c.Segs { // Segs is ordered by start
		if !r.Replicated {
			continue
		}
		if r.Start > cur {
			break
		}
		if r.End > cur {
			cur = r.End
		}
	}
	return cur
}

// ReplicaItem is one claim "this segment's exact ciphertext exists offsite".
type ReplicaItem struct {
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
}

// ReplicaResult counts a RecordReplica call.
type ReplicaResult struct{ Verified, Rejected int }

// RecordReplica records the result of ONE COMPLETE offsite check of the remote: the items whose id exists and whose sha
// equals the stored ciphertext sha become the remote's whole verified set, in one transaction. A segment that was
// verified earlier but is not in items (corrupt or gone offsite today) loses its claim for this remote; other
// remotes are untouched. Everything not accepted is rejected and counted. One arch_replica_runs row is written per
// call, so last_run_at moves even when nothing was verified. Callers must send the result of a complete check only.
func (s *Store) RecordReplica(remote string, items []ReplicaItem) (ReplicaResult, error) {
	if !remoteRe.MatchString(remote) {
		return ReplicaResult{}, fmt.Errorf("%w: remote", ErrBadInput)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return ReplicaResult{}, err
	}
	defer tx.Rollback()
	now := s.now().Unix()
	if _, err := tx.Exec(`DELETE FROM arch_replicas WHERE remote=?`, remote); err != nil {
		return ReplicaResult{}, err
	}
	var res ReplicaResult
	for _, it := range items {
		var have string
		err := tx.QueryRow(`SELECT sha256 FROM arch_segments WHERE id=?`, it.ID).Scan(&have)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && have != it.SHA256) {
			res.Rejected++
			continue
		}
		if err != nil {
			return ReplicaResult{}, err
		}
		if _, err := tx.Exec(`INSERT INTO arch_replicas(segment_id,remote,replica_sha256,verified_at) VALUES(?,?,?,?)
ON CONFLICT(segment_id,remote) DO UPDATE SET replica_sha256=excluded.replica_sha256, verified_at=excluded.verified_at`, it.ID, remote, it.SHA256, now); err != nil {
			return ReplicaResult{}, err
		}
		res.Verified++
	}
	if _, err := tx.Exec(`INSERT INTO arch_replica_runs(remote,at,verified,rejected) VALUES(?,?,?,?)`, remote, now, res.Verified, res.Rejected); err != nil {
		return ReplicaResult{}, err
	}
	return res, tx.Commit()
}

// ReplicaStatus summarises replication across all remotes.
type ReplicaStatus struct {
	LastRunAt             time.Time
	Replicated            int
	Unreplicated          int
	OldestUnreplicatedAge time.Duration
}

func (s *Store) ReplicaStatus() (ReplicaStatus, error) {
	var st ReplicaStatus
	var last sql.NullInt64
	if err := s.db.QueryRow(`SELECT MAX(at) FROM arch_replica_runs`).Scan(&last); err != nil {
		return st, err
	}
	if last.Valid {
		st.LastRunAt = time.Unix(last.Int64, 0)
	}
	var oldest sql.NullInt64
	err := s.db.QueryRow(`SELECT
  COALESCE(SUM(CASE WHEN EXISTS(SELECT 1 FROM arch_replicas r WHERE r.segment_id=g.id AND r.replica_sha256=g.sha256) THEN 1 ELSE 0 END),0),
  COALESCE(SUM(CASE WHEN EXISTS(SELECT 1 FROM arch_replicas r WHERE r.segment_id=g.id AND r.replica_sha256=g.sha256) THEN 0 ELSE 1 END),0),
  MIN(CASE WHEN EXISTS(SELECT 1 FROM arch_replicas r WHERE r.segment_id=g.id AND r.replica_sha256=g.sha256) THEN NULL ELSE g.stored_at END)
FROM arch_segments g`).Scan(&st.Replicated, &st.Unreplicated, &oldest)
	if err != nil {
		return st, err
	}
	if oldest.Valid {
		st.OldestUnreplicatedAge = s.now().Sub(time.Unix(oldest.Int64, 0))
	}
	return st, nil
}

// Pin is the recipient set remembered for a project.
type Pin struct {
	Project       string
	Fingerprints  string
	FirstSeenAt   time.Time
	LastSeenAt    time.Time
	Changed       bool
	LastChangedTo string
	ChangedAt     time.Time
}

func (s *Store) RecipientPins() ([]Pin, error) {
	rows, err := s.db.Query(`SELECT project,fingerprints,first_seen_at,last_seen_at,changed,last_changed_to,COALESCE(changed_at,0) FROM arch_recipient_pins ORDER BY project`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Pin
	for rows.Next() {
		var p Pin
		var a, b, c int64
		var ch int
		if err := rows.Scan(&p.Project, &p.Fingerprints, &a, &b, &ch, &p.LastChangedTo, &c); err != nil {
			return nil, err
		}
		p.FirstSeenAt, p.LastSeenAt, p.Changed = time.Unix(a, 0), time.Unix(b, 0), ch != 0
		if c != 0 {
			p.ChangedAt = time.Unix(c, 0)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AckPin re-pins a project to the set it last changed to, after the user confirmed the change.
func (s *Store) AckPin(project string) (bool, error) {
	res, err := s.db.Exec(`UPDATE arch_recipient_pins SET fingerprints=last_changed_to, changed=0, last_changed_to='' WHERE project=? AND changed=1`, project)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Stats are the archive totals. Nothing here names an id.
type Stats struct {
	Segments    int
	CipherBytes int64
	Sessions    int
	ByProject   map[string]int64
	FreeBytes   int64
}

func (s *Store) Stats() (Stats, error) {
	st := Stats{ByProject: map[string]int64{}}
	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(cipher_bytes),0), COUNT(DISTINCT agent||'/'||session_id) FROM arch_segments`).Scan(&st.Segments, &st.CipherBytes, &st.Sessions); err != nil {
		return st, err
	}
	rows, err := s.db.Query(`SELECT project, SUM(cipher_bytes) FROM arch_segments GROUP BY project`)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		var n int64
		if err := rows.Scan(&p, &n); err != nil {
			return st, err
		}
		st.ByProject[p] = n
	}
	if free, err := s.free(); err == nil {
		st.FreeBytes = free
	}
	return st, rows.Err()
}

// MaxBytes is the configured quota.
func (s *Store) MaxBytes() int64 { return s.maxBytes }

// Report is what Reconcile found at startup.
type Report struct {
	TempRemoved int
	Missing     []string
	Checked     int
}

// Reconcile removes leftover temporary files and lists index rows whose file is gone (rows are never deleted).
func (s *Store) Reconcile() (Report, error) {
	var rep Report
	err := filepath.WalkDir(s.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".tmp") {
			return nil
		}
		if os.Remove(p) == nil {
			rep.TempRemoved++
		}
		return nil
	})
	if err != nil {
		return rep, err
	}
	rows, err := s.db.Query(`SELECT id FROM arch_segments ORDER BY id`)
	if err != nil {
		return rep, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return rep, err
		}
		rep.Checked++
		if _, err := os.Stat(s.path(id)); err != nil {
			rep.Missing = append(rep.Missing, id)
		}
	}
	return rep, rows.Err()
}

// Verify checks one stored file against its index row (size and sha256 of the ciphertext).
func (s *Store) Verify(id string) (string, error) {
	g, ok, err := s.Head(id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrNotFound
	}
	f, err := os.Open(s.path(id))
	if err != nil {
		return "missing", nil
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", err
	}
	if n != g.CipherBytes || hex.EncodeToString(h.Sum(nil)) != g.SHA {
		return "corrupt", nil
	}
	return "ok", nil
}

// IDs lists every segment id (for the verify command), optionally one project.
func (s *Store) IDs(project string) ([]string, error) {
	q, args := `SELECT id FROM arch_segments`, []any{}
	if project != "" {
		q, args = q+` WHERE project=?`, append(args, project)
	}
	rows, err := s.db.Query(q+` ORDER BY id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
