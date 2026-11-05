package memory

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func firstNonInline(r Rendered) Page {
	for _, p := range r.Pages {
		if !p.Inline {
			return p
		}
	}
	return Page{}
}

func TestPagesKeepEveryNoteAccountedForAndTheCoreTierExplicitAboutWhatItLeavesOut(t *testing.T) {
	var active []Note
	for i := 0; i < 150; i++ {
		active = append(active, mkNote(i, "codemap", 60, 1+i%5))
	}
	active = append(active, mkNote(900, "decision", 80, 5), mkNote(901, "state", 80, 4))
	r := RenderBrief("p", active, BriefOpts{Now: time.Unix(1_800_100_000, 0), Tier: "core"})
	if v := CheckCoverage(active, r); len(v) != 0 {
		t.Fatalf("coverage with pages: %+v", v[:min(3, len(v))])
	}
	if !strings.Contains(r.Body, "## Pages not included above") {
		t.Fatalf("the core tier must list what it leaves out:\n%s", r.Body)
	}
	inline, paged := 0, 0
	for _, it := range r.Items {
		if it.Kind == "codemap" {
			inline++
		}
	}
	for _, pg := range r.Pages {
		if !pg.Inline {
			paged += len(pg.Refs)
			if len(pg.Refs) > 40 || pg.Summary == "" || !strings.Contains(r.Body, pg.ID) {
				t.Fatalf("page %+v must be listed with a summary and hold at most 40 notes", pg)
			}
		}
	}
	if inline+paged != 150 || inline != 60 {
		t.Fatalf("60 index lines inline, the other %d on pages: inline=%d paged=%d", 150-60, inline, paged)
	}
	for _, kind := range []string{"decision", "state"} {
		found := false
		for _, it := range r.Items {
			found = found || (it.Kind == kind && it.Mode == "full")
		}
		if !found {
			t.Fatalf("%s is never paged", kind)
		}
	}
	pg := firstNonInline(r)
	if !strings.HasPrefix(pg.ID, "p-key-files-") || !strings.Contains(r.Body, "\n- "+pg.ID+" · Key files and code · ") {
		t.Fatalf("page ids follow the section slug and the list line carries the section: %+v", pg)
	}
	page, err := RenderPage("p", active, pg.ID)
	if err != nil || !strings.Contains(page, "codemap note") || strings.Count(page, "\n- **") != len(pg.Refs) {
		t.Fatalf("a page can be fetched whole: %q %v", page, err)
	}
	if _, err := RenderPage("p", active, "p-nope-9"); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown page")
	}
	// removing one paged line from the page list is a coverage violation
	broken := r
	broken.Body = strings.Replace(r.Body, pg.ID, "p-gone-0", 1)
	if v := CheckCoverage(active, broken); len(v) == 0 {
		t.Fatal("a page that is not listed leaves its notes unaccounted for")
	}
	// a wrong count in the list is a violation too
	miscounted := r
	miscounted.Body = strings.Replace(r.Body, "· 40 notes ·", "· 39 notes ·", 1)
	if v := CheckCoverage(active, miscounted); len(v) == 0 {
		t.Fatal("a page listed with the wrong count must be reported")
	}
	// every page holds notes the inline index does not
	seen := map[string]bool{}
	for _, it := range r.Items {
		seen[it.Ref] = true
	}
	for _, p := range r.Pages {
		for _, ref := range p.Refs {
			if seen[ref] {
				t.Fatalf("%s is both inline and on %s", ref, p.ID)
			}
		}
	}
}

func TestIndexInlineMaxMovesTheLineBetweenIndexAndPages(t *testing.T) {
	var active []Note
	for i := 0; i < 30; i++ {
		active = append(active, mkNote(i, "finding", 60, 3))
	}
	r := RenderBrief("p", active, BriefOpts{IndexInlineMax: 10})
	n := 0
	for _, it := range r.Items {
		if it.Kind == "finding" {
			n++
		}
	}
	if n != 10 || len(r.Pages) != 1 || len(r.Pages[0].Refs) != 20 || r.Pages[0].ID != "p-findings-1" {
		t.Fatalf("inline=%d pages=%+v", n, r.Pages)
	}
	if v := CheckCoverage(active, r); len(v) != 0 {
		t.Fatal(v)
	}
}
