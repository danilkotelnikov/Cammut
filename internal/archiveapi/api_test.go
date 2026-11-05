package archiveapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cammut/internal/archive"
	"cammut/internal/gateway"
	"cammut/internal/ratelimit"
	"cammut/internal/store"
)

func ageLike(payload string) []byte {
	return []byte("age-encryption.org/v1\n-> X25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n--- CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n" + payload)
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

type env struct {
	a   *archive.Store
	st  *store.Store
	srv *httptest.Server
	n   int
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	a, err := archive.New(st.DB(), filepath.Join(t.TempDir(), "archive"), 1<<30, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(gateway.Handler(gateway.Deps{Store: st, Limiter: ratelimit.New(1000, 1000), Archive: New(a, st, nil)}))
	t.Cleanup(srv.Close)
	return &env{a: a, st: st, srv: srv}
}

func (e *env) token(t *testing.T, scopes ...string) string {
	t.Helper()
	e.n++
	plain, _, err := e.st.CreateToken("t"+string(rune('a'+e.n)), scopes)
	if err != nil {
		t.Fatal(err)
	}
	return plain
}

func (e *env) do(t *testing.T, method, tok, path string, hdr map[string]string, body []byte) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

func (e *env) put(t *testing.T, tok, id string, hdr map[string]string, body []byte) (*http.Response, []byte) {
	return e.do(t, "PUT", tok, "/v1/archive/segments/"+id, hdr, body)
}

func meta(start, end int64) archive.Meta {
	return archive.Meta{Agent: "claude-code", Project: "Cammut", SessionID: "s1", Kind: "transcript", FP: strings.Repeat("a", 64), SrcSHA256: strings.Repeat("c", 64), Codec: "zstd", SrcStart: start, SrcEnd: end, PlainBytes: 200}
}

func hdrFor(m archive.Meta, body []byte) map[string]string {
	return map[string]string{"X-Archive-Meta": b64(m), "X-Content-SHA256": sum(body)}
}

func TestScopesSeparateWritingFromReadingAndOnlyAgeBodiesAreAccepted(t *testing.T) {
	e := newEnv(t)
	writer := e.token(t, "archive/put", "archive/verify")
	reader := e.token(t, "archive/get", "archive/list", "archive/verify")
	other := e.token(t, "hindsight/*")
	m := meta(0, 50)
	body := ageLike("ciphertext-bytes")
	hdr := hdrFor(m, body)
	id := archive.SegmentID(m)
	if r, _ := e.put(t, other, id, hdr, body); r.StatusCode != 403 {
		t.Fatalf("foreign scope: %d", r.StatusCode)
	}
	if r, _ := e.put(t, writer, id, hdr, body); r.StatusCode != 201 {
		t.Fatalf("put: %d", r.StatusCode)
	}
	if r, _ := e.put(t, writer, id, hdr, body); r.StatusCode != 200 {
		t.Fatalf("second put is idempotent: %d", r.StatusCode)
	}
	if r, _ := e.do(t, "GET", writer, "/v1/archive/segments/"+id, nil, nil); r.StatusCode != 403 {
		t.Fatalf("the hook token must not be able to download ciphertext: %d", r.StatusCode)
	}
	if r, _ := e.do(t, "HEAD", writer, "/v1/archive/segments/"+id, nil, nil); r.StatusCode != 200 || r.Header.Get("X-Content-SHA256") != sum(body) {
		t.Fatalf("head: %d %v", r.StatusCode, r.Header)
	}
	if r, raw := e.do(t, "GET", reader, "/v1/archive/segments/"+id, nil, nil); r.StatusCode != 200 || !bytes.Equal(raw, body) {
		t.Fatalf("get: %d", r.StatusCode)
	}
	if r, raw := e.do(t, "GET", writer, "/v1/archive/sessions/claude-code/s1/coverage", nil, nil); r.StatusCode != 200 || !strings.Contains(string(raw), `"contiguous_to":50`) {
		t.Fatalf("coverage: %d %s", r.StatusCode, raw)
	}
	plain := []byte("this is plaintext and must never be stored")
	m2 := m
	m2.SrcStart, m2.SrcEnd = 50, 90
	if r, _ := e.put(t, writer, archive.SegmentID(m2), hdrFor(m2, plain), plain); r.StatusCode != 415 {
		t.Fatalf("plaintext body: %d", r.StatusCode)
	}
	big := ageLike(strings.Repeat("b", 5<<20))
	m3 := m
	m3.SrcStart, m3.SrcEnd = 90, 120
	if r, _ := e.put(t, writer, archive.SegmentID(m3), hdrFor(m3, big), big); r.StatusCode != 413 {
		t.Fatalf("oversized: %d", r.StatusCode)
	}
	rows, _ := e.st.QueryAudit(store.AuditFilter{Upstream: "archive"})
	if len(rows) == 0 {
		t.Fatal("archive calls must be audited")
	}
	for _, r := range rows {
		if strings.Contains(r.Note, "ciphertext") || strings.Contains(r.Tool, id) || strings.Contains(r.Note, id) {
			t.Fatalf("audit leaks content or ids: %+v", r)
		}
	}
}

func TestListStatusAndContentMismatchOverHTTP(t *testing.T) {
	e := newEnv(t)
	writer := e.token(t, "archive/put", "archive/verify")
	reader := e.token(t, "archive/get", "archive/list", "archive/verify")
	m := meta(0, 10)
	body := ageLike("x")
	hdr := hdrFor(m, body)
	hdr["X-Archive-Recipients"] = "bbbbbbbbbbbbbbbb,aaaaaaaaaaaaaaaa"
	id := archive.SegmentID(m)
	if r, raw := e.put(t, writer, id, hdr, body); r.StatusCode != 201 || !strings.Contains(string(raw), `"recipients_changed":false`) {
		t.Fatalf("put: %d %s", r.StatusCode, raw)
	}
	bad := m
	bad.SrcSHA256 = strings.Repeat("d", 64)
	if r, raw := e.put(t, writer, id, hdrFor(bad, body), body); r.StatusCode != 409 || !strings.Contains(string(raw), "content_mismatch") {
		t.Fatalf("same id, different plaintext hash: %d %s", r.StatusCode, raw)
	}
	m2 := meta(10, 20)
	hdr2 := hdrFor(m2, body)
	hdr2["X-Archive-Recipients"] = "aaaaaaaaaaaaaaaa,cccccccccccccccc"
	if r, raw := e.put(t, writer, archive.SegmentID(m2), hdr2, body); r.StatusCode != 201 || !strings.Contains(string(raw), `"recipients_changed":true`) {
		t.Fatalf("a changed recipient set is flagged, still stored: %d %s", r.StatusCode, raw)
	}
	if r, _ := e.do(t, "GET", writer, "/v1/archive/status", nil, nil); r.StatusCode != 403 {
		t.Fatalf("status needs archive/list: %d", r.StatusCode)
	}
	r, raw := e.do(t, "GET", reader, "/v1/archive/status", nil, nil)
	if r.StatusCode != 200 || !strings.Contains(string(raw), `"segments":2`) || !strings.Contains(string(raw), `"recipient_changes":[{`) || strings.Contains(string(raw), id) {
		t.Fatalf("status: %d %s", r.StatusCode, raw)
	}
	r, raw = e.do(t, "GET", reader, "/v1/archive/segments?project=Cammut&limit=5", nil, nil)
	if r.StatusCode != 200 || !strings.Contains(string(raw), id) || !strings.Contains(string(raw), `"cipher_bytes"`) {
		t.Fatalf("list: %d %s", r.StatusCode, raw)
	}
	if r, _ := e.do(t, "GET", writer, "/v1/archive/segments?project=Cammut", nil, nil); r.StatusCode != 403 {
		t.Fatalf("list needs archive/list: %d", r.StatusCode)
	}
	if r, _ := e.do(t, "GET", reader, "/v1/archive/segments/"+strings.Repeat("0", 32), nil, nil); r.StatusCode != 404 {
		t.Fatalf("unknown id: %d", r.StatusCode)
	}
}

func TestNoDecryptCodeAndNoPrivateKeyInTheRepository(t *testing.T) {
	root := "../.."
	mod, _ := os.ReadFile(filepath.Join(root, "go.mod"))
	if bytes.Contains(mod, []byte("filippo.io/age")) {
		t.Fatal("the server must not depend on an age implementation: it stores ciphertext and cannot read it")
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte("AGE-SECRET-KEY")) {
			t.Fatalf("%s mentions an age secret key", p)
		}
		return nil
	})
}

// F1: a rejected request must not leave its attacker-chosen strings in cammut.db, which is outside the archive quota.
func TestRejectedMetadataAndListFiltersNeverReachTheAuditLog(t *testing.T) {
	e := newEnv(t)
	writer := e.token(t, "archive/put", "archive/verify")
	reader := e.token(t, "archive/get", "archive/list", "archive/verify")
	body := ageLike("x")
	m := meta(0, 50)
	m.Project = strings.Repeat("TRANSCRIPT-TEXT ", 700000/16) // 700,000 characters
	if r, raw := e.put(t, writer, archive.SegmentID(m), hdrFor(m, body), body); r.StatusCode != 400 {
		t.Fatalf("invalid metadata must be a 400: %d %.80s", r.StatusCode, raw)
	}
	// valid JSON, but the header itself is far beyond any legitimate metadata
	m2 := meta(50, 60)
	m2.Recipients = strings.Repeat("aaaaaaaaaaaaaaaa,", 20000) + "aaaaaaaaaaaaaaaa"
	if r, _ := e.put(t, writer, archive.SegmentID(m2), hdrFor(m2, body), body); r.StatusCode != 400 {
		t.Fatalf("an oversized recipient list must be refused: %d", r.StatusCode)
	}
	if r, _ := e.do(t, "GET", reader, "/v1/archive/segments?project="+strings.Repeat("Z", 100000), nil, nil); r.StatusCode != 400 {
		t.Fatalf("an invalid project filter is a 400: %d", r.StatusCode)
	}
	// even a filter that is a valid name is audited bounded, and a good request still audits its project
	if r, _ := e.put(t, writer, archive.SegmentID(meta(0, 50)), hdrFor(meta(0, 50), body), body); r.StatusCode != 201 {
		t.Fatalf("good put: %d", r.StatusCode)
	}
	rows, _ := e.st.QueryAudit(store.AuditFilter{Upstream: "archive", Limit: 100})
	if len(rows) < 4 {
		t.Fatalf("every call is audited: %d rows", len(rows))
	}
	sawGood := false
	for _, r := range rows {
		if len(r.Note) > 64 || strings.Contains(r.Note, "TRANSCRIPT") || strings.Contains(r.Note, "ZZZZ") {
			t.Fatalf("audit note carries unvalidated input (%d bytes): %.40s", len(r.Note), r.Note)
		}
		if r.Note == "Cammut" {
			sawGood = true
		}
	}
	if !sawGood {
		t.Fatal("a valid project is still audited")
	}
}

// F5: the recipients each segment was sealed to are part of the coverage, so a client can require that every segment
// protecting a transcript includes the audited keys.
func TestCoverageAndListExposeEachSegmentsRecipients(t *testing.T) {
	e := newEnv(t)
	writer := e.token(t, "archive/put", "archive/verify")
	reader := e.token(t, "archive/list", "archive/verify")
	body := ageLike("x")
	old, cur := meta(0, 10), meta(10, 20)
	hOld, hCur := hdrFor(old, body), hdrFor(cur, body)
	hOld["X-Archive-Recipients"] = "bbbbbbbbbbbbbbbb,aaaaaaaaaaaaaaaa"
	hCur["X-Archive-Recipients"] = "dddddddddddddddd,cccccccccccccccc"
	for _, c := range []struct {
		m archive.Meta
		h map[string]string
	}{{old, hOld}, {cur, hCur}, {meta(20, 30), hdrFor(meta(20, 30), body)}} {
		if r, raw := e.put(t, writer, archive.SegmentID(c.m), c.h, body); r.StatusCode != 201 {
			t.Fatalf("put: %d %s", r.StatusCode, raw)
		}
	}
	var cov struct {
		Segs []struct {
			ID         string   `json:"id"`
			Start      int64    `json:"start"`
			Recipients []string `json:"recipients"`
		} `json:"segs"`
	}
	_, raw := e.do(t, "GET", writer, "/v1/archive/sessions/claude-code/s1/coverage", nil, nil)
	if err := json.Unmarshal(raw, &cov); err != nil || len(cov.Segs) != 3 {
		t.Fatalf("coverage: %v %s", err, raw)
	}
	want := [][]string{{"aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"}, {"cccccccccccccccc", "dddddddddddddddd"}, {}}
	for i, s := range cov.Segs {
		if strings.Join(s.Recipients, ",") != strings.Join(want[i], ",") || s.Recipients == nil {
			t.Fatalf("segment %d recipients %v, want %v (never null)", i, s.Recipients, want[i])
		}
	}
	var lst struct {
		Segments []struct {
			SrcStart   int64    `json:"src_start"`
			Recipients []string `json:"recipients"`
		} `json:"segments"`
	}
	_, raw = e.do(t, "GET", reader, "/v1/archive/segments?session=s1", nil, nil)
	if err := json.Unmarshal(raw, &lst); err != nil || len(lst.Segments) != 3 {
		t.Fatalf("list: %v %s", err, raw)
	}
	for _, s := range lst.Segments {
		if s.SrcStart == 10 && strings.Join(s.Recipients, ",") != "cccccccccccccccc,dddddddddddddddd" {
			t.Fatalf("list recipients: %v", s.Recipients)
		}
	}
}

// F6: a listing never silently stops at the page cap; it says so and hands out a cursor to continue from.
func TestListPaginatesWithACursorInsteadOfTruncating(t *testing.T) {
	e := newEnv(t)
	reader := e.token(t, "archive/list", "archive/verify")
	const total = 1001
	// index rows only (the listing never touches the files); a few segments share a second, as in a busy backlog
	tx, _ := e.st.DB().Begin()
	for i := 0; i < total; i++ {
		m := meta(int64(i)*10, int64(i)*10+10)
		if _, err := tx.Exec(`INSERT INTO arch_segments(id,agent,project,session_id,kind,relpath,fp,src_sha256,src_start,src_end,codec,plain_bytes,cipher_bytes,sha256,recipients,stored_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			archive.SegmentID(m), m.Agent, m.Project, m.SessionID, m.Kind, "", m.FP, m.SrcSHA256, m.SrcStart, m.SrcEnd, m.Codec, 1, 1, strings.Repeat("e", 64), "", 1_800_000_000+i/7); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	type page struct {
		Segments []struct {
			ID string `json:"id"`
		} `json:"segments"`
		Truncated  bool    `json:"truncated"`
		NextCursor *string `json:"next_cursor"`
	}
	seen := map[string]bool{}
	path := "/v1/archive/segments?session=s1&limit=1000"
	pages := 0
	for path != "" {
		_, raw := e.do(t, "GET", reader, path, nil, nil)
		var p page
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		pages++
		for _, s := range p.Segments {
			if seen[s.ID] {
				t.Fatalf("segment listed twice across pages: %s", s.ID)
			}
			seen[s.ID] = true
		}
		if pages == 1 && (len(p.Segments) != 1000 || !p.Truncated || p.NextCursor == nil || *p.NextCursor == "") {
			t.Fatalf("the first page must say it is not the whole answer: n=%d truncated=%v cursor=%v", len(p.Segments), p.Truncated, p.NextCursor)
		}
		path = ""
		if p.NextCursor != nil && *p.NextCursor != "" {
			path = "/v1/archive/segments?session=s1&limit=1000&cursor=" + *p.NextCursor
		} else if p.Truncated {
			t.Fatal("truncated without a cursor")
		}
		if pages > 5 {
			t.Fatal("cursor does not advance")
		}
	}
	if len(seen) != total || pages != 2 {
		t.Fatalf("pagination must deliver all %d segments in 2 pages: got %d in %d", total, len(seen), pages)
	}
	if r, _ := e.do(t, "GET", reader, "/v1/archive/segments?session=s1&cursor=%21%21bad", nil, nil); r.StatusCode != 400 {
		t.Fatalf("a malformed cursor is a 400: %d", r.StatusCode)
	}
	var cov struct {
		Segments int   `json:"segments"`
		Segs     []any `json:"segs"`
	}
	_, raw := e.do(t, "GET", reader, "/v1/archive/sessions/claude-code/s1/coverage", nil, nil)
	if json.Unmarshal(raw, &cov) != nil || cov.Segments != total || len(cov.Segs) != total {
		t.Fatalf("coverage references are never truncated: %d/%d", cov.Segments, len(cov.Segs))
	}
}
