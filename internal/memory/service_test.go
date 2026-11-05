package memory

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"cammut/internal/store"
)

type auditLog struct {
	mu   sync.Mutex
	rows []store.Audit
}

func (l *auditLog) add(a store.Audit) { l.mu.Lock(); l.rows = append(l.rows, a); l.mu.Unlock() }
func (l *auditLog) tools() map[string]bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]bool{}
	for _, r := range l.rows {
		if r.Upstream == "memory" {
			out[r.Tool] = true
		}
	}
	return out
}

func newService(t *testing.T) (*Service, *auditLog) {
	t.Helper()
	l := &auditLog{}
	return NewService(newStore(t), &Ranker{}, l.add, nil), l
}

var ctx = context.Background()
var actor = Actor{Agent: "mcp:test", TokenLabel: "test", TokenID: 7, Session: "s1"}

func remember(t *testing.T, svc *Service, kind, title, body string) Note {
	t.Helper()
	n, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: kind, Title: title, Body: body})
	if err != nil {
		t.Fatalf("remember %q: %v", title, err)
	}
	return n
}

func TestBriefVersionAdvancesOnlyWhenTheBodyChangesAndEveryCallIsAudited(t *testing.T) {
	svc, log := newService(t)
	a := remember(t, svc, "decision", "Use FTS5", "it is in the driver")
	v1, err := svc.Brief(ctx, actor, "p", BriefRequest{})
	if err != nil || v1.Version != 1 || v1.Generator != "template" || v1.Tier != "core" || !strings.Contains(v1.Body, "Use FTS5") || v1.Stale {
		t.Fatalf("%+v %v", v1, err)
	}
	if v, _ := svc.Brief(ctx, actor, "p", BriefRequest{}); v.Version != 1 {
		t.Fatalf("a repeated read does not bump the version: %d", v.Version)
	}
	remember(t, svc, "finding", "TEI is heavy", "851 MiB")
	if v, _ := svc.Brief(ctx, actor, "p", BriefRequest{}); v.Version != 2 {
		t.Fatalf("a new note changes the brief once: %d", v.Version)
	}
	if err := svc.Retract(ctx, actor, a.ID); err != nil {
		t.Fatal(err)
	}
	v3, _ := svc.Brief(ctx, actor, "p", BriefRequest{})
	if v3.Version != 3 || strings.Contains(v3.Body, "Use FTS5") {
		t.Fatalf("a retracted note leaves the next brief: %+v", v3)
	}
	for _, want := range []string{"remember", "brief", "retract"} {
		if !log.tools()[want] {
			t.Fatalf("audit lacks %s: %v", want, log.tools())
		}
	}
	svc.Remember(ctx, Actor{Agent: "gateway", SkipAudit: true}, Note{Project: "p", Kind: "finding", Title: "x", Body: "y"})
	log.mu.Lock()
	n := len(log.rows)
	log.mu.Unlock()
	svc.Brief(ctx, Actor{SkipAudit: true}, "p", BriefRequest{})
	log.mu.Lock()
	defer log.mu.Unlock()
	if len(log.rows) != n {
		t.Fatal("the MCP path is audited by the gateway; SkipAudit avoids a duplicate row")
	}
}

func TestMemoryAcceptanceBriefCoversSixtyNotesRetractAndSupersedeAdvanceTheVersionOnce(t *testing.T) {
	svc, _ := newService(t)
	var notes []Note
	for i := 0; i < 60; i++ {
		notes = append(notes, remember(t, svc, allKinds[i%len(allKinds)], fmt.Sprintf("note %d", i), fmt.Sprintf("body of note %d", i)))
	}
	for _, tier := range []string{"core", "full"} {
		v, err := svc.Brief(ctx, actor, "p", BriefRequest{Tier: tier})
		if err != nil || v.Accounting.Active != 60 || v.Accounting.Full+v.Accounting.Gist+v.Accounting.Index+v.Accounting.Paged != 60 {
			t.Fatalf("%s: %+v %v", tier, v.Accounting, err)
		}
	}
	before, _ := svc.Brief(ctx, actor, "p", BriefRequest{})
	for _, n := range notes[:3] {
		if err := svc.Retract(ctx, actor, n.ID); err != nil {
			t.Fatal(err)
		}
	}
	for i := 3; i < 6; i++ {
		if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: notes[i].Kind, Title: fmt.Sprintf("newer %d", i), Body: "replaces " + notes[i].Title, Supersedes: notes[i].ID}); err != nil {
			t.Fatal(err)
		}
	}
	after, err := svc.Brief(ctx, actor, "p", BriefRequest{})
	if err != nil || after.Version != before.Version+1 || after.Accounting.Active != 57 {
		t.Fatalf("version %d -> %d, active %d, err %v", before.Version, after.Version, after.Accounting.Active, err)
	}
	for _, n := range notes[:6] {
		if strings.Contains(after.Body, "("+strings.ToLower(n.ID[len(n.ID)-8:])+")") {
			t.Fatalf("%s is inactive and must be gone", n.Title)
		}
	}
	// superseding something that is not active, or in another project, is refused and creates nothing
	if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "again", Body: "x", Supersedes: notes[3].ID}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("an inactive predecessor: %v", err)
	}
	if _, err := svc.Remember(ctx, actor, Note{Project: "other", Kind: "finding", Title: "elsewhere", Body: "x", Supersedes: notes[10].ID}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("another project's predecessor: %v", err)
	}
	if got, _ := svc.Notes(actor, NoteFilter{Project: "other"}); len(got) != 0 {
		t.Fatal("a refused remember must not leave a note behind")
	}
}

func TestDeltaListsWhatChangedAndFallsBackToTheWholeBriefWhenHistoryIsGone(t *testing.T) {
	svc, _ := newService(t)
	remember(t, svc, "decision", "first", "one")
	v1, _ := svc.Brief(ctx, actor, "p", BriefRequest{})
	n2 := remember(t, svc, "decision", "second", "two")
	d, err := svc.Brief(ctx, actor, "p", BriefRequest{SinceVersion: v1.Version})
	if err != nil || !d.IsDelta || d.Version != 2 || len(d.Delta) != 1 || d.Delta[0].Op != "add" || !strings.HasSuffix(d.Delta[0].Ref, strings.ToLower(n2.ID[len(n2.ID)-8:])) || d.Body != "" {
		t.Fatalf("%+v %v", d, err)
	}
	if d, _ := svc.Brief(ctx, actor, "p", BriefRequest{SinceVersion: 2}); !d.IsDelta || len(d.Delta) != 0 || d.Version != 2 {
		t.Fatalf("the holder is current: %+v", d)
	}
	if full, _ := svc.Brief(ctx, actor, "p", BriefRequest{SinceVersion: 1, Tier: "full"}); full.IsDelta || full.Body == "" {
		t.Fatal("deltas exist for the core tier only")
	}
	for i := 0; i < 12; i++ {
		remember(t, svc, "finding", fmt.Sprintf("f%d", i), "x")
		svc.Brief(ctx, actor, "p", BriefRequest{})
	}
	gone, _ := svc.Brief(ctx, actor, "p", BriefRequest{SinceVersion: 1})
	if gone.IsDelta || gone.Body == "" || gone.Version < 12 {
		t.Fatalf("history older than 10 versions is gone, the whole brief comes back: %+v", gone.Version)
	}
}

func TestPagesDeliveriesAndSections(t *testing.T) {
	svc, _ := newService(t)
	for i := 0; i < 150; i++ {
		remember(t, svc, "codemap", fmt.Sprintf("file %03d", i), "what it does")
	}
	remember(t, svc, "task", "ship it", "open task body")
	v, err := svc.Brief(ctx, actor, "p", BriefRequest{})
	if err != nil || v.Accounting.Active != 151 || v.Accounting.Paged != 90 || !strings.Contains(v.Body, "p-key-files-3") {
		t.Fatalf("%+v %v", v.Accounting, err)
	}
	if !strings.HasPrefix(v.Delivered, "delivered: core; not delivered: p-key-files-1, p-key-files-2, p-key-files-3") {
		t.Fatalf("delivery line: %q", v.Delivered)
	}
	pg, err := svc.Brief(ctx, actor, "p", BriefRequest{Page: "p-key-files-2"})
	if err != nil || strings.Count(pg.Body, "\n- **") != 40 || !strings.Contains(pg.Delivered, "delivered: core + p-key-files-2; not delivered: p-key-files-1, p-key-files-3") {
		t.Fatalf("%v %q", err, pg.Delivered)
	}
	if _, err := svc.Brief(ctx, actor, "p", BriefRequest{Page: "p-nope-1"}); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown page")
	}
	st, err := svc.Status(actor, "p")
	if err != nil || st.Delivery == nil || st.Delivery.Session != "s1" || strings.Join(st.Delivery.Delivered, ",") != "core,p-key-files-2" || strings.Join(st.Delivery.NotDelivered, ",") != "p-key-files-1,p-key-files-3" {
		t.Fatalf("%+v %v", st.Delivery, err)
	}
	other := Actor{Agent: "mcp:other", TokenID: 8, Session: "s2"}
	svc.Brief(ctx, other, "p", BriefRequest{})
	if st, _ := svc.Status(actor, "p"); st.Delivery.Session != "s2" || strings.Join(st.Delivery.Delivered, ",") != "core" {
		t.Fatalf("status shows the newest session: %+v", st.Delivery)
	}
	if sec, err := svc.Brief(ctx, actor, "p", BriefRequest{Section: "open tasks"}); err != nil || !strings.Contains(sec.Body, "## Open tasks") || !strings.Contains(sec.Body, "ship it") || strings.Contains(sec.Body, "file 001") {
		t.Fatalf("section: %q %v", sec.Body, err)
	}
	if _, err := svc.Brief(ctx, actor, "p", BriefRequest{Section: "nonsense"}); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown section")
	}
	full, _ := svc.Brief(ctx, actor, "p", BriefRequest{Tier: "full"})
	if full.Tier != "full" || strings.Contains(full.Body, "Pages not included above") || !strings.Contains(full.Body, "file 149") || full.Accounting.Paged != 0 {
		t.Fatal("the full tier has every note inline")
	}
	if st, _ := svc.Status(actor, "p"); len(st.Delivery.NotDelivered) != 0 || len(st.Delivery.Delivered) < 4 {
		t.Fatalf("the full tier carries every page, so none is undelivered: %+v", st.Delivery)
	}
	if _, err := svc.Brief(ctx, actor, "p", BriefRequest{Tier: "huge"}); !errors.Is(err, ErrBadInput) {
		t.Fatal("unknown tier")
	}
}

func TestRecallByRefAndPageReturnsWholeNotes(t *testing.T) {
	svc, _ := newService(t)
	long := strings.Repeat("The whole body matters here. ", 40)
	n := remember(t, svc, "decision", "Long decision", long)
	for i := 0; i < 100; i++ {
		remember(t, svc, "finding", fmt.Sprintf("finding %03d", i), "paged away")
	}
	ref := strings.ToLower(n.ID[len(n.ID)-8:])
	hits, err := svc.Recall(ctx, actor, RecallQuery{Project: "p", Refs: []string{ref}})
	if err != nil || len(hits) != 1 || hits[0].Body != long || hits[0].Ref != ref {
		t.Fatalf("refs return the whole note: %+v %v", hits, err)
	}
	if _, err := svc.Recall(ctx, actor, RecallQuery{Project: "p", Refs: []string{"zzzzzzzz"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown ref: %v", err)
	}
	hits, err = svc.Recall(ctx, actor, RecallQuery{Project: "p", Pages: []string{"p-findings-1"}})
	if err != nil || len(hits) != 40 {
		t.Fatalf("a page returns all of its notes: %d %v", len(hits), err)
	}
	st, _ := svc.Status(actor, "p")
	if st.Delivery == nil || !strings.Contains(strings.Join(st.Delivery.Delivered, ","), "p-findings-1") {
		t.Fatalf("a page fetched by recall counts as delivered: %+v", st.Delivery)
	}
	q, err := svc.Recall(ctx, actor, RecallQuery{Project: "p", Query: "long decision"})
	if err != nil || len(q) == 0 || q[0].ID != n.ID || q[0].Ref != ref {
		t.Fatalf("query recall: %+v %v", q, err)
	}
	if _, err := svc.Recall(ctx, actor, RecallQuery{Project: "p", Kinds: []string{"gossip"}, Query: "x"}); !errors.Is(err, ErrBadInput) {
		t.Fatal("unknown kind filter")
	}
}

func TestHandoffReplacesThePreviousOneAndShowsAtOnce(t *testing.T) {
	svc, _ := newService(t)
	h1, err := svc.Handoff(ctx, actor, HandoffIn{Project: "p", Agent: "warp", Summary: "stopped after task 2.5", OpenTasks: []string{"2.6", "2.7"}, NextSteps: []string{"run the gate"}})
	if err != nil || h1.Kind != "state" || h1.Importance != 4 || !strings.HasPrefix(h1.Title, "Handoff from warp ") {
		t.Fatalf("%+v %v", h1, err)
	}
	h2, err := svc.Handoff(ctx, actor, HandoffIn{Project: "p", Summary: "second handoff"})
	if err != nil || !strings.HasPrefix(h2.Title, "Handoff from mcp:test ") {
		t.Fatalf("%+v %v", h2, err)
	}
	old, _, _ := svc.st.GetNote(h1.ID)
	if old.Status != "superseded" || old.SupersededBy != h2.ID {
		t.Fatalf("the previous handoff is superseded: %+v", old)
	}
	v, _ := svc.Brief(ctx, actor, "p", BriefRequest{})
	if strings.Contains(v.Body, "stopped after task 2.5") || !strings.Contains(v.Body, "second handoff") {
		t.Fatalf("only the newest handoff is in the brief:\n%s", v.Body)
	}
	if _, err := svc.Handoff(ctx, actor, HandoffIn{Project: "p", Summary: strings.Repeat("long ", 400)}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("a handoff that cannot fit one note is refused, not cut: %v", err)
	}
	if _, err := svc.Handoff(ctx, actor, HandoffIn{Project: "p"}); !errors.Is(err, ErrBadInput) {
		t.Fatal("a handoff needs a summary")
	}
}

func TestACoverageViolationKeepsThePreviousBriefAndFlagsItStale(t *testing.T) {
	svc, _ := newService(t)
	remember(t, svc, "decision", "kept", "body")
	v1, _ := svc.Brief(ctx, actor, "p", BriefRequest{})
	orig := render
	t.Cleanup(func() { render = orig })
	render = func(project string, notes []Note, o BriefOpts) Rendered {
		r := RenderBrief(project, notes, o)
		r.Body = strings.Replace(r.Body, "(", "[", 1) // silently drop a ref
		return r
	}
	remember(t, svc, "decision", "new", "body")
	v2, err := svc.Brief(ctx, actor, "p", BriefRequest{})
	if err != nil || v2.Version != v1.Version || !v2.Stale || strings.Contains(v2.Body, "new") {
		t.Fatalf("the old brief is served, flagged stale: %+v %v", v2, err)
	}
	svc2, _ := newService(t)
	remember(t, svc2, "decision", "never stored", "body")
	if _, err := svc2.Brief(ctx, actor, "p", BriefRequest{}); err == nil {
		t.Fatal("with no previous brief a violating one must be an error, not stored")
	}
	if _, ok, _ := svc2.st.GetBrief("p"); ok {
		t.Fatal("nothing may be stored")
	}
}

func TestProjectResolution(t *testing.T) {
	svc, _ := newService(t)
	if _, err := svc.Brief(ctx, actor, "", BriefRequest{}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("no projects and no name: %v", err)
	}
	remember(t, svc, "state", "only one", "x")
	if v, err := svc.Brief(ctx, actor, "", BriefRequest{}); err != nil || v.Project != "p" {
		t.Fatalf("a single project is the default: %+v %v", v, err)
	}
	svc.Remember(ctx, actor, Note{Project: "q", Kind: "state", Title: "second", Body: "x"})
	if _, err := svc.Brief(ctx, actor, "", BriefRequest{}); !errors.Is(err, ErrBadInput) {
		t.Fatal("two projects need a name")
	}
	if _, err := svc.Brief(ctx, actor, "../etc", BriefRequest{}); !errors.Is(err, ErrBadInput) {
		t.Fatal("bad name")
	}
	if _, err := svc.Brief(ctx, actor, "nope", BriefRequest{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown project")
	}
	ps, _ := svc.Projects(actor)
	st, _ := svc.Status(actor, "")
	if len(ps) != 2 || st.Projects != 2 || st.Notes != 2 || st.Briefs != 1 {
		t.Fatalf("%+v %+v", ps, st)
	}
}
