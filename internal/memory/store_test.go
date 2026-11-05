package memory

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cammut/internal/store"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return NewStore(st.DB(), func() time.Time { return time.Unix(1_800_000_000, 0) })
}

func TestFTS5IsCompiledInAndFindsRussian(t *testing.T) {
	s := newStore(t)
	var opts string
	rows, err := s.db.Query(`PRAGMA compile_options`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var o string
		rows.Scan(&o)
		opts += o + " "
	}
	rows.Close()
	if !strings.Contains(opts, "ENABLE_FTS5") {
		t.Fatalf("FTS5 is not compiled into modernc.org/sqlite: %s", opts)
	}
	if err := s.UpsertProject("Cammut", "C:/Users/alice/Documents/Cammut"); err != nil {
		t.Fatal(err)
	}
	n, err := s.AddNote(Note{Project: "Cammut", Kind: "howto", Title: "Запуск тестов на VDS", Body: "bash dev/gate.sh прогоняет gofmt, vet и go test -race", Tags: []string{"go", "vds"}, SourceAgent: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if len(n.ID) != 26 {
		t.Fatalf("ulid: %q", n.ID)
	}
	for _, q := range []string{"тестов", "gofmt", "запуск VDS", "Тестов"} {
		hits, err := s.SearchFTS("Cammut", q, nil, 5)
		if err != nil || len(hits) != 1 || hits[0].ID != n.ID || hits[0].Score <= 0 || hits[0].Score > 1 {
			t.Fatalf("query %q: %+v %v", q, hits, err)
		}
	}
	if hits, _ := s.SearchFTS("Other", "gofmt", nil, 5); len(hits) != 0 {
		t.Fatal("search must be scoped to the project")
	}
	if hits, err := s.SearchFTS("Cammut", `-- "" ()`, nil, 5); err != nil || len(hits) != 0 {
		t.Fatalf("a query with no word characters must be an empty answer, not an error: %v %v", hits, err)
	}
}

func TestNotesAreValidatedDefaultedAndSuperseded(t *testing.T) {
	s := newStore(t)
	s.UpsertProject("p", "")
	for _, bad := range []Note{
		{Project: "p", Kind: "rumour", Title: "x", Body: "y"},
		{Project: "bad name!", Kind: "finding", Title: "x", Body: "y"},
		{Project: "p", Kind: "finding", Title: "", Body: "y"},
		{Project: "p", Kind: "finding", Title: strings.Repeat("t", 121), Body: "y"},
		{Project: "p", Kind: "finding", Title: "x", Body: strings.Repeat("b", 1501)},
		{Project: "p", Kind: "finding", Title: "x", Body: "y", Importance: 9},
		{Project: "p", Kind: "finding", Title: "x", Body: "y", Tags: []string{"a b"}},
	} {
		if _, err := s.AddNote(bad); err == nil || !errors.Is(err, ErrBadInput) {
			t.Fatalf("accepted %+v (err %v)", bad, err)
		}
	}
	a, err := s.AddNote(Note{Project: "p", Kind: "decision", Title: "Use tokens from env", Body: "older", SourceAgent: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if a.Importance != 3 || a.Confidence != 0.7 || a.Status != "active" || a.LastConfirmedAt.IsZero() {
		t.Fatalf("defaults: %+v", a)
	}
	b, _ := s.AddNote(Note{Project: "p", Kind: "decision", Title: "Use tokens from the vault", Body: "newer", SourceAgent: "test"})
	if err := s.Supersede(a.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Supersede(a.ID, b.ID); err == nil {
		t.Fatal("superseding an already superseded note must fail")
	}
	got, _, _ := s.GetNote(a.ID)
	nb, _, _ := s.GetNote(b.ID)
	if got.Status != "superseded" || got.SupersededBy != b.ID || nb.Supersedes != a.ID {
		t.Fatalf("chain: %+v %+v", got, nb)
	}
	active, _ := s.ListNotes(NoteFilter{Project: "p", Kind: "decision"})
	if len(active) != 1 || active[0].ID != b.ID {
		t.Fatalf("default listing is active only: %+v", active)
	}
	all, _ := s.ListNotes(NoteFilter{Project: "p", Status: "any"})
	if len(all) != 2 {
		t.Fatalf("status=any lists everything: %d", len(all))
	}
	if hits, _ := s.ListNotes(NoteFilter{Project: "p", Query: "vault"}); len(hits) != 1 || hits[0].ID != b.ID {
		t.Fatalf("listing with a text query: %+v", hits)
	}
	st := "retracted"
	if err := s.UpdateNote(b.ID, NotePatch{Status: &st}); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.SearchFTS("p", "vault", nil, 5); len(hits) != 0 {
		t.Fatal("retracted notes must not come back from search")
	}
	if err := s.UpdateNote("nope", NotePatch{Status: &st}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
	projects, _ := s.Projects()
	if len(projects) != 1 || projects[0].Name != "p" || projects[0].Notes != 0 {
		t.Fatalf("project row counts active notes: %+v", projects)
	}
}

func TestBriefRoundTrip(t *testing.T) {
	s := newStore(t)
	s.UpsertProject("p", "")
	if _, ok, _ := s.GetBrief("p"); ok {
		t.Fatal("no brief yet")
	}
	if err := s.SetBrief(Brief{Project: "p", Body: "# p", Generator: "template"}); err != nil {
		t.Fatal(err)
	}
	s.SetBrief(Brief{Project: "p", Body: "# p v2", BodyHash: "h2", Generator: "template"})
	s.SetBrief(Brief{Project: "p", Body: "# p v2", BodyHash: "h2", Generator: "template"}) // identical body: no new version
	b, ok, _ := s.GetBrief("p")
	if !ok || b.Version != 2 || b.Body != "# p v2" || b.Stale {
		t.Fatalf("brief: %+v", b)
	}
	if _, ok, _ := s.BriefHistory("p", 2); !ok {
		t.Fatal("history of the stored version")
	}
	s.MarkBriefStale("p")
	b, _, _ = s.GetBrief("p")
	if !b.Stale {
		t.Fatal("stale flag")
	}
	for i := 0; i < 15; i++ {
		s.SetBrief(Brief{Project: "p", Body: "x", BodyHash: "n" + string(rune('a'+i)), Items: []Item{{Ref: "aaaaaaaa", Line: "- x (aaaaaaaa)"}}})
	}
	if _, ok, _ := s.BriefHistory("p", 3); ok {
		t.Fatal("only the 10 newest versions are kept")
	}
	if items, ok, _ := s.BriefHistory("p", 17); !ok || len(items) != 1 {
		t.Fatalf("newest history: %v %v", items, ok)
	}
}

func TestVectorsRoundTripAndAreScopedToActiveNotes(t *testing.T) {
	s := newStore(t)
	a, _ := s.AddNote(Note{Project: "p", Kind: "finding", Title: "a", Body: "b", SourceAgent: "t"})
	if err := s.SetVector(a.ID, "m", []float32{0.5, -1, 2}); err != nil {
		t.Fatal(err)
	}
	vs, err := s.Vectors("p")
	if err != nil || len(vs) != 1 || vs[0].NoteID != a.ID || vs[0].Model != "m" || len(vs[0].Vec) != 3 || vs[0].Vec[1] != -1 {
		t.Fatalf("%+v %v", vs, err)
	}
	st := "retracted"
	s.UpdateNote(a.ID, NotePatch{Status: &st})
	if vs, _ := s.Vectors("p"); len(vs) != 0 {
		t.Fatal("a retracted note has no vector arm")
	}
}

func TestFTSQueryIsBounded(t *testing.T) {
	q := ftsQuery(strings.Repeat("alpha ", 20000))
	if n := strings.Count(q, " OR ") + 1; n != 12 {
		t.Fatalf("terms: %d, want the cap of 12", n)
	}
	if got := ftsQuery(strings.Repeat("x", 5000)); len([]rune(got)) > 64 {
		t.Fatalf("one huge word became %d runes", len([]rune(got)))
	}
	if got := ftsQuery("fts5 driver"); got != `"fts5"* OR "driver"*` {
		t.Fatalf("normal queries are unchanged: %q", got)
	}
}
