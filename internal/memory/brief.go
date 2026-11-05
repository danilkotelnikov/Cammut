package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// The brief is a deterministic, exhaustive render of a project's active notes. There is no size limit anywhere:
// every note ends up as a full line, a gist line with a pointer, an index line with a pointer, or a member of a
// listed page. CheckCoverage proves it; Tokens is informational.

const (
	mustCoverBody      = 600 // runes: a longer body is shown as a gist
	defaultIndexInline = 60
	pageSize           = 40
	pagesHeading       = "## Pages not included above (fetch with memory_brief page=<id> or memory_recall pages=[…])"
	indexSection       = "Reference index"
)

// BriefOpts controls one render. Promote and Demote are plan 6's levers (nil here).
type BriefOpts struct {
	Now            time.Time
	Tier           string            // core (default) or full
	IndexInlineMax int               // core tier: reference notes shown as index lines before paging; default 60
	Promote        map[string]string // ref -> "gist"|"full": show the note at that level instead of its default
	Demote         func(Note) bool   // true: render the note as a gist line
}

// Page is a group of at most 40 notes of one section that the core tier lists instead of rendering.
type Page struct {
	ID, Section string
	Refs        []string
	Summary     string
	Tokens      int
	Inline      bool
}

// Rendered is the result of RenderBrief. Items holds the inline lines and the page-list lines (Kind "page").
type Rendered struct {
	Body     string
	Items    []Item
	Pages    []Page // the pages the core tier lists; empty in the full tier
	Tokens   int
	BodyHash string
}

// Violation is one way a rendering fails to account for the notes.
type Violation struct{ NoteID, Kind, Reason string }

type secInfo struct{ name, slug string }

var (
	secState    = secInfo{"Current state", ""}
	secOpen     = secInfo{"Open tasks", ""}
	secDecision = secInfo{"Decisions in force", ""}
	secError    = secInfo{"Known errors and fixes", ""}
	secPref     = secInfo{"Preferences", ""}
	secCode     = secInfo{"Key files and code", "key-files"}
	secHowto    = secInfo{"Commands that work", "commands"}
	secFinding  = secInfo{"Findings", "findings"}
	secDone     = secInfo{"Done tasks (recent)", "done-tasks"}

	mustSections = []secInfo{secState, secOpen, secDecision, secError, secPref}
	refSections  = []secInfo{secCode, secHowto, secFinding, secDone}
)

func sectionOf(n Note) secInfo {
	switch n.Kind {
	case "state":
		return secState
	case "task":
		if n.TaskStatus == "done" {
			return secDone
		}
		return secOpen
	case "decision":
		return secDecision
	case "error_fix":
		return secError
	case "preference":
		return secPref
	case "codemap":
		return secCode
	case "howto":
		return secHowto
	}
	return secFinding
}

func isReference(s secInfo) bool { return s.slug != "" }

// before is the fixed order inside a section: importance descending, created ascending, id.
func before(a, b Note) bool {
	if a.Importance != b.Importance {
		return a.Importance > b.Importance
	}
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.Before(b.CreatedAt)
	}
	return a.ID < b.ID
}

// Ref is the short reference shown as "(ref)": the last 8 lowercase characters of the ULID, 12 when the 8-character
// form is already taken by another note. taken maps ref -> note id.
func Ref(id string, taken map[string]string) string {
	low := strings.ToLower(id)
	tail := func(n int) string {
		if len(low) < n {
			return low
		}
		return low[len(low)-n:]
	}
	if r := tail(8); taken[r] == "" || taken[r] == id {
		taken[r] = id
		return r
	}
	r := tail(12)
	taken[r] = id
	return r
}

// assignRefs gives every note its ref; collisions are settled in id order so the result does not depend on input order.
func assignRefs(active []Note) map[string]string {
	ids := make([]string, len(active))
	for i, n := range active {
		ids[i] = n.ID
	}
	sort.Strings(ids)
	taken := map[string]string{}
	refs := make(map[string]string, len(ids))
	for _, id := range ids {
		refs[id] = Ref(id, taken)
	}
	return refs
}

func flat(s string) string { return strings.Join(strings.Fields(s), " ") }

func tokensOf(s string) int { return (runes(s) + 2) / 3 }

// firstSentence is the body up to the first ". ", "! ", "? ", newline or 。; a body without one is its own sentence.
func firstSentence(body string) string {
	r := []rune(strings.TrimSpace(body))
	for i, c := range r {
		switch {
		case c == '\n':
			return flat(string(r[:i]))
		case c == '。':
			return flat(string(r[:i+1]))
		case (c == '.' || c == '!' || c == '?') && (i+1 == len(r) || unicode.IsSpace(r[i+1])):
			return flat(string(r[:i+1]))
		}
	}
	return flat(string(r))
}

// gistOf is the stored gist when it passes ValidateGist, else the first sentence of the body.
func gistOf(n Note) string {
	if g := flat(n.Gist); g != "" && len(ValidateGist(n.Body, g)) == 0 {
		return g
	}
	return firstSentence(n.Body)
}

func lineFull(n Note, ref string) string {
	if b := flat(n.Body); b != "" {
		return fmt.Sprintf("- **%s** — %s (%s)", flat(n.Title), b, ref)
	}
	return fmt.Sprintf("- **%s** (%s)", flat(n.Title), ref)
}

func lineGist(n Note, ref string) string {
	g := gistOf(n)
	if g == "" {
		return lineFull(n, ref)
	}
	return fmt.Sprintf("- **%s** — %s [+more: %s] (%s)", flat(n.Title), g, ref, ref)
}

func lineIndex(n Note, ref string) string {
	if g := gistOf(n); g != "" {
		return fmt.Sprintf("- %s — %s · %s (%s)", flat(n.Title), g, n.Kind, ref)
	}
	return fmt.Sprintf("- %s · %s (%s)", flat(n.Title), n.Kind, ref)
}

// modeOf picks full or gist for a note that is shown as text.
func (o BriefOpts) modeOf(n Note, ref string) string {
	switch o.Promote[ref] {
	case "full", "gist":
		return o.Promote[ref]
	}
	if (o.Demote != nil && o.Demote(n)) || runes(n.Body) > mustCoverBody {
		return "gist"
	}
	return "full"
}

func (o BriefOpts) item(n Note, ref, section, mode string) Item {
	var line string
	switch mode {
	case "full":
		line = lineFull(n, ref)
	case "gist":
		line = lineGist(n, ref)
	default:
		line = lineIndex(n, ref)
	}
	if mode == "gist" && !strings.Contains(line, "[+more: ") {
		mode = "full" // an empty gist degrades to the whole (empty) body
	}
	return Item{Ref: ref, NoteID: n.ID, Kind: n.Kind, Section: section, Mode: mode, Line: line}
}

func commas(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// RenderBrief renders all of active (the caller has already dropped inactive and expired notes).
func RenderBrief(project string, active []Note, opts BriefOpts) Rendered {
	full := opts.Tier == "full"
	maxInline := opts.IndexInlineMax
	if maxInline <= 0 {
		maxInline = defaultIndexInline
	}
	refs := assignRefs(active)
	bySec := map[string][]Note{}
	for _, n := range active {
		s := sectionOf(n)
		bySec[s.name] = append(bySec[s.name], n)
	}
	for k := range bySec {
		ns := bySec[k]
		sort.Slice(ns, func(i, j int) bool { return before(ns[i], ns[j]) })
	}
	var b strings.Builder
	var items []Item
	var pages []Page
	fmt.Fprintf(&b, "# %s — brief\n", project)
	emit := func(heading string, its []Item) {
		if len(its) == 0 {
			return
		}
		b.WriteString("\n" + heading + "\n")
		for _, it := range its {
			b.WriteString(it.Line + "\n")
		}
		items = append(items, its...)
	}
	textSection := func(s secInfo) {
		var its []Item
		for _, n := range bySec[s.name] {
			its = append(its, opts.item(n, refs[n.ID], s.name, opts.modeOf(n, refs[n.ID])))
		}
		emit("## "+s.name, its)
	}
	for _, s := range mustSections {
		textSection(s)
	}
	if full {
		for _, s := range refSections {
			textSection(s)
		}
	} else {
		// Which reference notes stay inline: promoted ones, then the most important and most recent up to maxInline.
		var all []Note
		for _, s := range refSections {
			all = append(all, bySec[s.name]...)
		}
		pick := append([]Note(nil), all...)
		sort.Slice(pick, func(i, j int) bool {
			a, c := pick[i], pick[j]
			if a.Importance != c.Importance {
				return a.Importance > c.Importance
			}
			if !a.CreatedAt.Equal(c.CreatedAt) {
				return a.CreatedAt.After(c.CreatedAt)
			}
			return a.ID < c.ID
		})
		inline, count := map[string]bool{}, 0
		for _, n := range pick {
			if opts.Promote[refs[n.ID]] != "" {
				inline[n.ID] = true
			} else if count < maxInline {
				inline[n.ID] = true
				count++
			}
		}
		sort.Slice(all, func(i, j int) bool { return before(all[i], all[j]) })
		var its []Item
		for _, n := range all {
			if !inline[n.ID] {
				continue
			}
			ref := refs[n.ID]
			mode := "index"
			if opts.Promote[ref] != "" {
				mode = opts.modeOf(n, ref)
			}
			its = append(its, opts.item(n, ref, indexSection, mode))
		}
		emit("## "+indexSection, its)
		for _, s := range refSections {
			var rest []Note
			for _, n := range bySec[s.name] {
				if !inline[n.ID] {
					rest = append(rest, n)
				}
			}
			for p := 0; p*pageSize < len(rest); p++ {
				chunk := rest[p*pageSize : min((p+1)*pageSize, len(rest))]
				pages = append(pages, makePage(s, p+1, chunk, refs, opts))
			}
		}
		if len(pages) > 0 {
			var its []Item
			for _, pg := range pages {
				its = append(its, Item{Ref: pg.ID, Kind: "page", Section: "Pages", Mode: "page", Line: "- " + pg.ID + " · " + pg.Summary})
			}
			emit(pagesHeading, its)
		}
	}
	body := b.String()
	sum := sha256.Sum256([]byte(body))
	return Rendered{Body: body, Items: items, Pages: pages, Tokens: tokensOf(body), BodyHash: hex.EncodeToString(sum[:])}
}

func makePage(s secInfo, n int, chunk []Note, refs map[string]string, opts BriefOpts) Page {
	pg := Page{ID: fmt.Sprintf("p-%s-%d", s.slug, n), Section: s.name}
	var tops []string
	for i, note := range chunk {
		ref := refs[note.ID]
		pg.Refs = append(pg.Refs, ref)
		pg.Tokens += tokensOf(opts.item(note, ref, s.name, opts.modeOf(note, ref)).Line)
		if i < 3 {
			tops = append(tops, "“"+flat(note.Title)+"”")
		}
	}
	plural := "s"
	if len(chunk) == 1 {
		plural = ""
	}
	pg.Summary = fmt.Sprintf("%s · %d note%s · ~%s tokens · top: %s", s.name, len(chunk), plural, commas(pg.Tokens), strings.Join(tops, "; "))
	return pg
}

// RenderPage returns the lines of one page of the core tier whole (full or gist by the usual rule).
func RenderPage(project string, active []Note, pageID string) (string, error) {
	r := RenderBrief(project, active, BriefOpts{Tier: "core"})
	refs := assignRefs(active)
	byRef := map[string]Note{}
	for _, n := range active {
		byRef[refs[n.ID]] = n
	}
	for _, pg := range r.Pages {
		if pg.ID != pageID {
			continue
		}
		var b strings.Builder
		fmt.Fprintf(&b, "# %s — %s (%s)\n\n", project, pg.Section, pg.ID)
		for _, ref := range pg.Refs {
			n := byRef[ref]
			b.WriteString(BriefOpts{}.item(n, ref, pg.Section, BriefOpts{}.modeOf(n, ref)).Line + "\n")
		}
		return b.String(), nil
	}
	return "", fmt.Errorf("%w: page %q", ErrNotFound, pageID)
}

var (
	lineRefRe  = regexp.MustCompile(`\(([0-9a-z]{8}|[0-9a-z]{12})\)\s*$`)
	pageLineRe = regexp.MustCompile(`^- (p-[a-z0-9-]+) · [^·]+ · (\d+) notes? · `)
)

// CheckCoverage returns every way r fails to account for active: a note with no line and no listed page, a listed
// page with a wrong count or missing from the page list, a ref or page that belongs to nothing, a duplicate ref.
// An empty result is the guarantee the service demands before it stores a brief.
func CheckCoverage(active []Note, r Rendered) []Violation {
	refOf := assignRefs(active)
	noteOf := map[string]string{}
	for id, ref := range refOf {
		noteOf[ref] = id
	}
	seen := map[string]int{}
	listed := map[string]int{}
	inPages := false
	for _, line := range strings.Split(r.Body, "\n") {
		if strings.HasPrefix(line, "## ") {
			inPages = strings.HasPrefix(line, "## Pages not included above")
			continue
		}
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		if inPages {
			if m := pageLineRe.FindStringSubmatch(line); m != nil {
				listed[m[1]], _ = strconv.Atoi(m[2])
				continue
			}
		}
		if m := lineRefRe.FindStringSubmatch(line); m != nil {
			seen[m[1]]++
		}
	}
	var vs []Violation
	add := func(id, kind, reason string) { vs = append(vs, Violation{id, kind, reason}) }
	pageOf := map[string][]string{}
	known := map[string]bool{}
	for _, p := range r.Pages {
		if p.Inline {
			continue
		}
		known[p.ID] = true
		for _, ref := range p.Refs {
			pageOf[ref] = append(pageOf[ref], p.ID)
			if _, ok := noteOf[ref]; !ok {
				add("", "page", "stale-ref")
			}
		}
		if n, ok := listed[p.ID]; !ok {
			add("", "page", "page-not-listed:"+p.ID)
		} else if n != len(p.Refs) {
			add("", "page", "page-count:"+p.ID)
		}
	}
	for id := range listed {
		if !known[id] {
			add("", "page", "stale-page:"+id)
		}
	}
	for _, n := range active {
		ref := refOf[n.ID]
		pgs := pageOf[ref]
		switch {
		case seen[ref] > 0 && len(pgs) > 0:
			add(n.ID, n.Kind, "duplicate")
		case seen[ref] == 0 && len(pgs) == 0:
			add(n.ID, n.Kind, "missing")
		case len(pgs) > 1:
			add(n.ID, n.Kind, "duplicate")
		case seen[ref] == 0:
			if _, ok := listed[pgs[0]]; !ok {
				add(n.ID, n.Kind, "page-not-listed")
			}
		}
	}
	for ref, c := range seen {
		if _, ok := noteOf[ref]; !ok {
			add("", "", "stale-ref")
		} else if c > 1 {
			add(noteOf[ref], "", "duplicate-ref")
		}
	}
	sort.Slice(vs, func(i, j int) bool {
		if vs[i].NoteID != vs[j].NoteID {
			return vs[i].NoteID < vs[j].NoteID
		}
		return vs[i].Reason < vs[j].Reason
	})
	return vs
}
