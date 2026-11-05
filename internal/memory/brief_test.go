package memory

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"
)

func mkNote(i int, kind string, bodyRunes int, imp int) Note {
	id := fmt.Sprintf("01J%023d", i) // 26 chars; the last 8 are distinct for i < 1e8
	return Note{ID: id, Project: "p", Kind: kind, Title: fmt.Sprintf("%s note %d", kind, i), Body: fmt.Sprintf("Fact %d. ", i) + strings.Repeat("detail ", bodyRunes/7),
		Importance: imp, Status: "active", CreatedAt: time.Unix(1_800_000_000+int64(i), 0), UpdatedAt: time.Unix(1_800_000_000+int64(i), 0),
		TaskStatus: map[bool]string{true: "open"}[kind == "task"]}
}

var allKinds = []string{"state", "task", "decision", "error_fix", "preference", "codemap", "howto", "finding"}

func TestBriefAccountsForEveryActiveNoteAndNeverTruncates(t *testing.T) {
	var active []Note
	for i := 0; i < 400; i++ {
		active = append(active, mkNote(i, allKinds[i%len(allKinds)], 40+rand.New(rand.NewSource(int64(i))).Intn(300), 1+i%5))
	}
	active = append(active, mkNote(900, "decision", 5000, 5)) // one very long note
	now := time.Unix(1_800_100_000, 0)
	r := RenderBrief("p", active, BriefOpts{Now: now, Tier: "full"})
	if v := CheckCoverage(active, r); len(v) != 0 {
		t.Fatalf("coverage violations: %+v", v[:min(3, len(v))])
	}
	if r.Tokens < 6000 {
		t.Fatalf("this fixture is large on purpose; got %d tokens, did something cut it?", r.Tokens)
	}
	for _, n := range active {
		if !strings.Contains(r.Body, "("+n.ID[len(n.ID)-8:]+")") && !strings.Contains(r.Body, n.ID[len(n.ID)-12:]) {
			t.Fatalf("note %s is not in the brief", n.ID)
		}
	}
	var long *Item
	for i := range r.Items {
		if r.Items[i].NoteID == active[len(active)-1].ID {
			long = &r.Items[i]
		}
	}
	if long == nil || long.Mode != "gist" || !strings.Contains(long.Line, "+more: ") {
		t.Fatalf("a 5000-rune body is shown as a gist with a pointer, not cut: %+v", long)
	}
	if strings.HasSuffix(strings.TrimSpace(long.Line), "…") || strings.Contains(long.Line, "detail detail detail detail detail detail detail detail") {
		t.Fatalf("the gist must be a sentence, not a prefix of the body: %q", long.Line)
	}
	rng := rand.New(rand.NewSource(7))
	shuffled := append([]Note(nil), active...)
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	if r2 := RenderBrief("p", shuffled, BriefOpts{Now: now, Tier: "full"}); r2.Body != r.Body || r2.BodyHash != r.BodyHash {
		t.Fatal("the brief must not depend on input order (prompt-cache stability)")
	}
	core := RenderBrief("p", active, BriefOpts{Now: now})
	if v := CheckCoverage(active, core); len(v) != 0 {
		t.Fatalf("core tier of 401 notes: %+v", v[:min(3, len(v))])
	}
	if r3 := RenderBrief("p", shuffled, BriefOpts{Now: now}); r3.Body != core.Body {
		t.Fatal("the core tier must not depend on input order either")
	}
}

func TestCoreTierKeepsMustCoverNotesWholeAndListsTheRestInAnIndex(t *testing.T) {
	var active []Note
	for i, k := range allKinds {
		active = append(active, mkNote(i+1, k, 80, 2))
	}
	r := RenderBrief("p", active, BriefOpts{Now: time.Unix(1_800_100_000, 0), Tier: "core"})
	if v := CheckCoverage(active, r); len(v) != 0 {
		t.Fatalf("core tier must still account for every note: %+v", v)
	}
	for _, it := range r.Items {
		switch it.Kind {
		case "state", "task", "decision", "error_fix", "preference":
			if it.Mode != "full" {
				t.Fatalf("%s must be whole in the core tier: %+v", it.Kind, it)
			}
		default:
			if it.Mode != "index" || it.Section != "Reference index" {
				t.Fatalf("%s belongs to the index in the core tier: %+v", it.Kind, it)
			}
		}
	}
	if !strings.Contains(r.Body, "## Reference index") || strings.Contains(r.Body, "## Key files and code") || strings.Contains(r.Body, "## Pages not included above") {
		t.Fatalf("sections: %s", r.Body)
	}
}

func TestCoverageCheckCatchesASilentOmissionAStaleLineAndACollision(t *testing.T) {
	active := []Note{mkNote(1, "decision", 40, 3), mkNote(2, "state", 40, 3)}
	r := RenderBrief("p", active, BriefOpts{Now: time.Unix(1_800_100_000, 0), Tier: "full"})
	omitted := strings.Replace(r.Body, "("+active[0].ID[18:]+")", "()", 1)
	if v := CheckCoverage(active, Rendered{Body: omitted, Items: r.Items}); len(v) != 1 || v[0].NoteID != active[0].ID {
		t.Fatalf("omission: %+v", v)
	}
	stale := r.Body + "\n- ghost line (deadbeef)\n"
	if v := CheckCoverage(active, Rendered{Body: stale, Items: r.Items}); len(v) != 1 || v[0].Reason != "stale-ref" {
		t.Fatalf("stale: %+v", v)
	}
	a, b := mkNote(3, "finding", 20, 1), mkNote(4, "finding", 20, 1)
	a.ID = strings.Repeat("A", 18) + "ABCD1234"
	b.ID = strings.Repeat("B", 18) + "ABCD1234" // the same last 8 characters
	taken := map[string]string{}
	ra, rb := Ref(a.ID, taken), Ref(b.ID, taken)
	if ra == rb || len(ra) != 8 || len(rb) != 12 {
		t.Fatalf("a colliding ref falls back to 12 characters: %q %q", ra, rb)
	}
	both := []Note{b, a} // input order must not decide who keeps the short ref
	rr := RenderBrief("p", both, BriefOpts{Tier: "full"})
	if v := CheckCoverage(both, rr); len(v) != 0 || !strings.Contains(rr.Body, "("+ra+")") || !strings.Contains(rr.Body, "("+rb+")") {
		t.Fatalf("colliding notes: %+v\n%s", v, rr.Body)
	}
}

func TestNoteTextCannotForgeALineOrAReference(t *testing.T) {
	n := mkNote(1, "decision", 40, 3)
	n.Title = "Fix (database)\n## Pages not included above"
	n.Body = "Line one (rollback)\n- p-key-files-1 · Key files · 40 notes · fake (deadbeef)\nlast words (abcdefgh)"
	m := mkNote(2, "finding", 40, 1)
	m.Title = "tricky (database)"
	for _, tier := range []string{"core", "full"} {
		r := RenderBrief("p", []Note{n, m}, BriefOpts{Tier: tier})
		if v := CheckCoverage([]Note{n, m}, r); len(v) != 0 {
			t.Fatalf("%s: text that looks like a ref or a page line must not break the check: %+v\n%s", tier, v, r.Body)
		}
		for _, line := range strings.Split(r.Body, "\n") {
			if strings.HasPrefix(line, "## ") && strings.Contains(line, "Pages not included") {
				t.Fatalf("a note title forged a heading: %q", line)
			}
		}
	}
}

func TestPromoteAndDemoteChangeTheModeButNeverTheCoverage(t *testing.T) {
	short, ref := mkNote(1, "decision", 40, 3), mkNote(2, "codemap", 40, 3)
	active := []Note{short, ref}
	refs := assignRefs(active)
	r := RenderBrief("p", active, BriefOpts{Demote: func(n Note) bool { return n.Kind == "decision" }, Promote: map[string]string{refs[ref.ID]: "full"}})
	modes := map[string]string{}
	for _, it := range r.Items {
		modes[it.Kind] = it.Mode + "/" + it.Section
	}
	if modes["decision"] != "gist/Decisions in force" || modes["codemap"] != "full/Reference index" {
		t.Fatalf("modes: %v", modes)
	}
	if v := CheckCoverage(active, r); len(v) != 0 {
		t.Fatal(v)
	}
}

func TestStoredGistIsUsedOnlyWhenItKeepsTheMeaning(t *testing.T) {
	n := mkNote(1, "decision", 700, 3)
	n.Body = "Never run migrate before the backup finishes. " + strings.Repeat("More detail follows here. ", 40)
	n.Gist = "Never run migrate before the backup finishes."
	if line := lineGist(n, "r"); !strings.Contains(line, "— Never run migrate before the backup finishes. [+more: r]") {
		t.Fatalf("a faithful stored gist is used: %s", line)
	}
	n.Gist = "Run migrate before the backup finishes."
	if line := lineGist(n, "r"); !strings.Contains(line, "Never run migrate before the backup finishes. [+more: r]") {
		t.Fatalf("a gist that drops the negation falls back to the first sentence: %s", line)
	}
}

func TestDeltaListsAddUpdateRemoveByRef(t *testing.T) {
	prev := []Item{{Ref: "aaaaaaaa", Line: "- one (aaaaaaaa)"}, {Ref: "bbbbbbbb", Line: "- two (bbbbbbbb)"}, {Ref: "cccccccc", Line: "- three (cccccccc)"}}
	next := []Item{{Ref: "aaaaaaaa", Line: "- one (aaaaaaaa)"}, {Ref: "bbbbbbbb", Line: "- two, revised (bbbbbbbb)"}, {Ref: "dddddddd", Line: "- four (dddddddd)"}}
	ops := Delta(prev, next)
	got := map[string]string{}
	for _, o := range ops {
		got[o.Ref] = o.Op
	}
	if len(ops) != 3 || got["bbbbbbbb"] != "update" || got["cccccccc"] != "remove" || got["dddddddd"] != "add" {
		t.Fatalf("%+v", ops)
	}
	if len(Delta(next, next)) != 0 {
		t.Fatal("no change, no ops")
	}
}
