package memory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"cammut/internal/store"
)

// render is RenderBrief; tests swap it to prove that a brief that fails the coverage check is never stored.
var render = RenderBrief

// Actor says who is calling. SkipAudit is for callers whose own layer already writes the audit row (the MCP gateway).
type Actor struct {
	Agent, TokenLabel, IP, Session string
	TokenID                        int64
	SkipAudit                      bool
	AuditActor                     string // "user:<name>" for console calls: written to the audit row's actor column
	NoDelivery                     bool   // a person looking at the brief is not an agent being sent it: record no delivery
	Human                          bool   // a signed-in person (console): their notes default to epistemic=observed
	CanObserve                     bool   // may set or confirm epistemic=observed: a person, or a token with scope memory/observe
}

// BriefRequest selects what Brief returns. Page and Section are mutually exclusive with SinceVersion.
type BriefRequest struct {
	Tier         string // core (default) | full
	Section      string // e.g. "open tasks"
	Page         string // e.g. "p-key-files-2"
	SinceVersion int
}

// Accounting says how every active note is shown. Paged notes are the ones the page list stands for.
type Accounting struct {
	Active int `json:"active"`
	Full   int `json:"full"`
	Gist   int `json:"gist"`
	Index  int `json:"index"`
	Paged  int `json:"paged"`
}

// BriefView is the answer to a brief request.
type BriefView struct {
	Project     string     `json:"project"`
	Version     int        `json:"version"`
	Generator   string     `json:"generator"`
	Stale       bool       `json:"stale"`
	Tier        string     `json:"tier"`
	GeneratedAt time.Time  `json:"generated_at"`
	Body        string     `json:"body,omitempty"`
	Tokens      int        `json:"tokens"`
	Accounting  Accounting `json:"accounting"`
	Delta       []Op       `json:"ops,omitempty"`
	IsDelta     bool       `json:"delta"`
	Delivered   string     `json:"delivered,omitempty"` // "delivered: core + p-a; not delivered: p-b"
}

// DeliveryView is what the newest session of a project was sent.
type DeliveryView struct {
	Agent        string    `json:"agent"`
	Session      string    `json:"last_session"`
	At           time.Time `json:"at"`
	Version      int       `json:"brief_version"`
	Delivered    []string  `json:"delivered"`
	NotDelivered []string  `json:"not_delivered"`
}

type StatusView struct {
	Projects          int           `json:"projects"`
	Notes             int           `json:"notes"`
	Briefs            int           `json:"briefs"`
	Queue             int           `json:"queue"`
	LastIngest        time.Time     `json:"last_ingest"`
	LastConsolidation time.Time     `json:"last_consolidation"`
	Failures24h       int           `json:"failures_24h"`
	Delivery          *DeliveryView `json:"delivery,omitempty"`
}

// HandoffIn is what an agent leaves behind when it stops.
type HandoffIn struct {
	Project, Agent, Summary string
	OpenTasks, NextSteps    []string
}

// Service is the memory API every surface (REST, MCP, console) goes through.
type Service struct {
	st    *Store
	r     *Ranker
	audit func(store.Audit)
	now   func() time.Time
	regen sync.Mutex
	wg    sync.WaitGroup
}

// NewService wires the store, the ranker (nil or zero is allowed: FTS-only recall) and the audit sink (may be nil).
func NewService(st *Store, r *Ranker, audit func(store.Audit), now func() time.Time) *Service {
	if r == nil {
		r = &Ranker{}
	}
	if r.st == nil {
		r.st = st
	}
	if now == nil {
		now = time.Now
	}
	return &Service{st: st, r: r, audit: audit, now: now}
}

// Wait blocks until background embedding of new notes has finished (shutdown and tests).
func (s *Service) Wait() { s.wg.Wait() }

func (s *Service) record(a Actor, op, project string, start time.Time, err error) {
	if s.audit == nil || a.SkipAudit {
		return
	}
	if !ValidProject(project) {
		project = ""
	}
	s.audit(store.Audit{TS: start, TokenID: a.TokenID, Upstream: "memory", Tool: op, OK: err == nil, Millis: s.now().Sub(start).Milliseconds(), Note: project, IP: a.IP, Actor: a.AuditActor})
}

func (s *Service) resolve(project string) (string, error) {
	if project == "" {
		ps, err := s.st.Projects()
		if err != nil {
			return "", err
		}
		if len(ps) != 1 {
			return "", bad("project is required")
		}
		return ps[0].Name, nil
	}
	if !ValidProject(project) {
		return "", bad("project name must match %s", projectRe)
	}
	ok, err := s.st.HasProject(project)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%w: project %q", ErrNotFound, project)
	}
	return project, nil
}

// RegenerateBrief renders both tiers from all active notes and stores them if, and only if, both account for every note.
func (s *Service) RegenerateBrief(ctx context.Context, project string) error {
	s.regen.Lock()
	defer s.regen.Unlock()
	notes, err := s.briefNotes(project)
	if err != nil {
		return err
	}
	now := s.now()
	core := render(project, notes, BriefOpts{Now: now, Tier: "core"})
	full := render(project, notes, BriefOpts{Now: now, Tier: "full"})
	for tier, r := range map[string]Rendered{"core": core, "full": full} {
		if v := CheckCoverage(notes, r); len(v) > 0 {
			_ = s.st.MarkBriefStale(project)
			return fmt.Errorf("brief %s tier does not account for every note (%d violations, first: %+v); the previous brief is kept", tier, len(v), v[0])
		}
	}
	h := sha256.Sum256([]byte(core.Body + "\x00" + full.Body))
	return s.st.SetBrief(Brief{Project: project, Body: core.Body, BodyFull: full.Body, Generator: "template",
		BodyHash: hex.EncodeToString(h[:]), Tokens: core.Tokens, Items: core.Items})
}

// current returns the stored brief, regenerating it first when it is missing or stale. If regeneration fails and an
// older brief exists, that one is returned flagged stale.
func (s *Service) current(ctx context.Context, project string) (Brief, error) {
	b, ok, err := s.st.GetBrief(project)
	if err != nil {
		return Brief{}, err
	}
	if ok && !b.Stale {
		return b, nil
	}
	if rerr := s.RegenerateBrief(ctx, project); rerr != nil {
		if ok {
			b.Stale = true
			return b, nil
		}
		return Brief{}, rerr
	}
	b, _, err = s.st.GetBrief(project)
	return b, err
}

func countModes(items []Item) (full, gist, index int) {
	for _, it := range items {
		switch it.Mode {
		case "full":
			full++
		case "gist":
			gist++
		case "index":
			index++
		}
	}
	return
}

func (s *Service) accounting(project string, items []Item) (Accounting, error) {
	active, err := s.st.CountActive(project)
	if err != nil {
		return Accounting{}, err
	}
	f, g, i := countModes(items)
	return Accounting{Active: active, Full: f, Gist: g, Index: i, Paged: max(active-f-g-i, 0)}, nil
}

func sectionText(body, name string) (string, bool) {
	name = strings.ToLower(strings.Join(strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(name)), " "))
	if name == "" {
		return "", false
	}
	var out []string
	in := false
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "## ") {
			in = strings.HasPrefix(strings.ToLower(line[3:]), name)
		}
		if in {
			out = append(out, line)
		}
	}
	if len(out) == 0 {
		return "", false
	}
	return strings.Join(out, "\n") + "\n", true
}

// Brief returns the project brief: the core tier by default, a delta, a section, a page or the full tier.
func (s *Service) Brief(ctx context.Context, a Actor, project string, req BriefRequest) (v BriefView, err error) {
	start := s.now()
	defer func() { s.record(a, "brief", v.Project, start, err) }()
	if project, err = s.resolve(project); err != nil {
		return v, err
	}
	if req.Tier == "" {
		req.Tier = "core"
	}
	if req.Tier != "core" && req.Tier != "full" {
		return v, bad("tier must be core or full")
	}
	b, err := s.current(ctx, project)
	if err != nil {
		return v, err
	}
	v = BriefView{Project: project, Version: b.Version, Generator: b.Generator, Stale: b.Stale, Tier: req.Tier, GeneratedAt: b.GeneratedAt, Tokens: b.Tokens}
	items := b.Items
	body := b.Body
	if req.Tier == "full" {
		body = b.BodyFull
		v.Tokens = tokensOf(body)
		notes, err := s.briefNotes(project)
		if err != nil {
			return v, err
		}
		items = render(project, notes, BriefOpts{Tier: "full"}).Items
	}
	if v.Accounting, err = s.accounting(project, items); err != nil {
		return v, err
	}
	deliver := []string{"core"}
	switch {
	case req.Page != "":
		notes, err := s.briefNotes(project)
		if err != nil {
			return v, err
		}
		if v.Body, err = RenderPage(project, notes, req.Page); err != nil {
			return v, err
		}
		v.Tier, v.Tokens, deliver = "core", tokensOf(v.Body), []string{req.Page}
	case req.Section != "":
		sec, ok := sectionText(body, req.Section)
		if !ok {
			return v, fmt.Errorf("%w: section %q", ErrNotFound, req.Section)
		}
		v.Body, v.Tokens, deliver = sec, tokensOf(sec), nil
	case req.SinceVersion > 0 && req.Tier == "core" && req.SinceVersion <= b.Version:
		prev, ok := items, true
		if req.SinceVersion != b.Version {
			if prev, ok, err = s.st.BriefHistory(project, req.SinceVersion); err != nil {
				return v, err
			}
		}
		if !ok { // the history the reader needs is gone: send the whole brief, never a guess
			v.Body = body
			break
		}
		v.IsDelta, v.Delta, v.Tokens = true, Delta(prev, items), 0 // the delta brings the reader to this version: core is delivered
	default:
		v.Body = body
		if req.Tier == "full" {
			deliver = []string{"full"}
		}
	}
	var ds []Delivery
	for _, p := range deliver {
		if a.NoDelivery {
			break
		}
		ds = append(ds, Delivery{TokenID: a.TokenID, Agent: a.Agent, Session: a.Session, Project: project, BriefVersion: b.Version, PageID: p, At: start, Via: "brief"})
	}
	if err = s.st.AddDeliveries(ds); err != nil {
		return v, err
	}
	if len(ds) > 0 {
		v.Delivered, err = s.deliveryLine(project, a, b)
	}
	return v, err
}

// deliveryUniverse is what a complete session of the current brief receives: the core part and every listed page.
func deliveryUniverse(b Brief) []string {
	u := []string{"core"}
	for _, it := range b.Items {
		if it.Kind == "page" {
			u = append(u, it.Ref)
		}
	}
	return u
}

func (s *Service) deliveryLine(project string, a Actor, b Brief) (string, error) {
	got, err := s.st.DeliveredPages(project, a.Agent, a.Session, b.Version)
	if err != nil {
		return "", err
	}
	have, missing := deliveredSplit(got, deliveryUniverse(b))
	d := "none"
	if len(have) > 0 {
		d = strings.Join(have, " + ")
	}
	n := "none"
	if len(missing) > 0 {
		n = strings.Join(missing, ", ")
	}
	return "delivered: " + d + "; not delivered: " + n, nil
}

// deliveredSplit separates the universe into sent and not sent. A full-tier delivery carries every page inline.
func deliveredSplit(got, universe []string) (have, missing []string) {
	set := map[string]bool{}
	for _, g := range got {
		set[g] = true
	}
	for _, u := range universe {
		if set[u] || set["full"] {
			have = append(have, u)
		} else {
			missing = append(missing, u)
		}
		delete(set, u)
	}
	var extra []string
	for g := range set {
		extra = append(extra, g) // "full", or a page of an older layout
	}
	sort.Strings(extra)
	return append(have, extra...), missing
}

// briefNotes are the notes the brief accounts for: active and not speculative. Refs, pages and accounting all use this list.
func (s *Service) briefNotes(project string) ([]Note, error) {
	return s.st.ListNotes(NoteFilter{Project: project, NoSpeculative: true})
}

func (s *Service) refsOf(project string) (map[string]string, map[string]Note, error) {
	notes, err := s.briefNotes(project)
	if err != nil {
		return nil, nil, err
	}
	refs := assignRefs(notes)
	byRef := make(map[string]Note, len(notes))
	for _, n := range notes {
		byRef[refs[n.ID]] = n
	}
	return refs, byRef, nil
}

// Recall finds notes by text, or returns whole notes by ref or by page id (the drill-down for gist and index lines).
func (s *Service) Recall(ctx context.Context, a Actor, q RecallQuery) ([]Scored, error) {
	r, err := s.RecallResult(ctx, a, q)
	return r.Hits, err
}

// RecallResult is Recall plus the abstention: Abstained is "below_threshold" when a text query found nothing that
// clears the relevance gate (an honest "nothing relevant", not an error).
func (s *Service) RecallResult(ctx context.Context, a Actor, q RecallQuery) (RecallResult, error) {
	hits, abstained, err := s.recallNotes(ctx, a, q)
	return RecallResult{Hits: hits, Abstained: abstained}, err
}

func (s *Service) recallNotes(ctx context.Context, a Actor, q RecallQuery) (hits []Scored, abstained string, err error) {
	start := s.now()
	defer func() { s.record(a, "recall", q.Project, start, err) }()
	if q.Project, err = s.resolve(q.Project); err != nil {
		return nil, "", err
	}
	for _, k := range q.Kinds {
		if !kinds[k] {
			return nil, "", bad("unknown kind %q", k)
		}
	}
	switch {
	case len(q.Refs) > 0 || len(q.Pages) > 0:
		refs, byRef, err := s.refsOf(q.Project)
		if err != nil {
			return nil, "", err
		}
		want := append([]string(nil), q.Refs...)
		var deliveries []Delivery
		if len(q.Pages) > 0 {
			b, err := s.current(ctx, q.Project)
			if err != nil {
				return nil, "", err
			}
			notes, _ := s.briefNotes(q.Project)
			r := render(q.Project, notes, BriefOpts{Tier: "core"})
			for _, id := range q.Pages {
				found := false
				for _, pg := range r.Pages {
					if pg.ID == id {
						want = append(want, pg.Refs...)
						found = true
					}
				}
				if !found {
					return nil, "", fmt.Errorf("%w: page %q", ErrNotFound, id)
				}
				deliveries = append(deliveries, Delivery{TokenID: a.TokenID, Agent: a.Agent, Session: a.Session, Project: q.Project, BriefVersion: b.Version, PageID: id, At: start, Via: "recall"})
			}
		}
		seen := map[string]bool{}
		for _, ref := range want {
			ref = strings.ToLower(strings.TrimSpace(ref))
			if n, ok := byRef[ref]; ok && !seen[ref] {
				seen[ref] = true
				hits = append(hits, Scored{Note: n, Score: 1, Ref: refs[n.ID]})
			}
		}
		if len(hits) == 0 {
			return nil, "", fmt.Errorf("%w: no note for the given refs", ErrNotFound)
		}
		if a.NoDelivery {
			deliveries = nil
		}
		return hits, "", s.st.AddDeliveries(deliveries)
	case strings.TrimSpace(q.Query) == "":
		return nil, "", bad("query, refs or pages is required")
	}
	res, err := s.r.Recall(ctx, q)
	if err != nil {
		return nil, "", err
	}
	hits = res.Hits
	if len(hits) > 0 {
		refs, _, err := s.refsOf(q.Project)
		if err != nil {
			return nil, "", err
		}
		for i := range hits {
			hits[i].Ref = refs[hits[i].ID]
		}
	}
	return hits, res.Abstained, nil
}

func (s *Service) index(n Note) {
	if s.r == nil || s.r.emb == nil {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.r.Index(c, n); err != nil {
			s.r.warn("indexing a note failed", err)
		}
	}()
}

// History lists every version of a keyed note, newest first (the current one is the active one).
func (s *Service) History(ctx context.Context, a Actor, project, key string) (out []Note, err error) {
	start := s.now()
	defer func() { s.record(a, "history", project, start, err) }()
	if project, err = s.resolve(project); err != nil {
		return nil, err
	}
	if !keyRe.MatchString(key) {
		return nil, bad("key must match %s", keyRe)
	}
	if out, err = s.st.KeyHistory(project, key); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: no note with key %q", ErrNotFound, key)
	}
	return out, nil
}

// Remember stores one note from an agent. Supersedes names an active note of the same project that it replaces. It
// never refuses a near-duplicate (programmatic callers store what they are given); agents go through RememberFull.
func (s *Service) Remember(ctx context.Context, a Actor, n Note) (Note, error) {
	out, err := s.RememberFull(ctx, a, n, RememberOpts{Force: true})
	return out.Note, err
}

// suggestions embeds the new note and returns its vector and up to three same-project, same-kind, same-agent active
// notes whose cosine reaches the candidate threshold, best first. An embedder that is down gives no suggestions.
func (s *Service) suggestions(ctx context.Context, n Note) ([]float32, []Suggestion) {
	if s.r == nil || s.r.emb == nil {
		return nil, nil
	}
	t, b, err := checkText(n.Title, n.Body)
	if err != nil {
		return nil, nil // AddNote will say why
	}
	c, cancel := context.WithTimeout(ctx, embedTimeout)
	defer cancel()
	v, err := s.r.emb.Embed(c, []string{t + "\n" + b})
	if err != nil || len(v) != 1 {
		if err != nil {
			s.r.warn("embedding a new note failed, no neighbour check", err)
		}
		return nil, nil
	}
	rows, err := s.st.VectorsFor(n.Project, n.Kind, n.SourceAgent)
	if err != nil {
		return v[0], nil
	}
	d := s.r.Dedup.orDefault()
	type cand struct {
		id  string
		cos float64
	}
	var cs []cand
	for _, row := range rows {
		if row.Model != s.r.emb.Model() {
			continue
		}
		if cos := cosine(v[0], row.Vec); cos >= d.Candidate {
			cs = append(cs, cand{row.NoteID, cos})
		}
	}
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].cos != cs[j].cos {
			return cs[i].cos > cs[j].cos
		}
		return cs[i].id < cs[j].id
	})
	if len(cs) > maxSuggestions {
		cs = cs[:maxSuggestions]
	}
	var out []Suggestion
	for _, c := range cs {
		if old, ok, err := s.st.GetNote(c.id); err == nil && ok {
			out = append(out, Suggestion{Note: old, Cosine: c.cos})
		}
	}
	return v[0], out
}

// RememberFull is Remember plus the write-time checks. A note without a key and without supersedes is compared with
// the agent's existing notes: a near-duplicate (cosine >= 0.92, same numbers) is not stored unless opts.Force, and
// closer-than-0.85 neighbours come back as PossibleSupersedes and are queued for review. Nothing is ever superseded
// automatically.
func (s *Service) RememberFull(ctx context.Context, a Actor, n Note, opts RememberOpts) (res RememberOutcome, err error) {
	start := s.now()
	defer func() { s.record(a, "remember", n.Project, start, err) }()
	old := n.Supersedes
	n.Supersedes = ""
	n.SourceAgent = a.Agent
	if n.SourceAgent == "" {
		n.SourceAgent = "unknown"
	}
	if n.Confidence == 0 {
		n.Confidence = 0.9
	}
	switch {
	case n.Epistemic == "":
		n.Epistemic = Inferred
		if a.Human {
			n.Epistemic = Observed
		}
	case !epistemics[n.Epistemic]:
		return res, bad("epistemic must be observed, inferred or speculative")
	case n.Epistemic == Observed && !a.CanObserve:
		return res, bad("only a person (the console) or a token with scope memory/observe may write an observed note; agents write inferred or speculative")
	}
	if old != "" {
		prev, ok, err := s.st.GetNote(old)
		if err != nil {
			return res, err
		}
		if !ok {
			return res, fmt.Errorf("%w: supersedes: no note %q", ErrNotFound, old)
		}
		if prev.Project != n.Project || prev.Status != "active" {
			return res, bad("supersedes: %q is not an active note of project %s", old, n.Project)
		}
	}
	var vec []float32
	if n.Key == "" && old == "" && n.Epistemic != Speculative && ValidProject(n.Project) && kinds[n.Kind] {
		var sug []Suggestion
		vec, sug = s.suggestions(ctx, n)
		d := s.r.Dedup.orDefault()
		if len(sug) > 0 && sug[0].Cosine >= d.Duplicate && sameNumbers(n.Title+" "+n.Body, sug[0].Note.Title+" "+sug[0].Note.Body) && !opts.Force {
			dup := sug[0].Note
			res.Duplicate = &dup
			return res, nil
		}
		res.PossibleSupersedes = sug
	}
	if res.Note, err = s.st.AddNote(n); err != nil {
		return RememberOutcome{}, err
	}
	out := res.Note
	if old != "" && out.Supersedes != old { // a key already retired this note
		if err = s.st.Supersede(old, out.ID); err != nil {
			return res, err
		}
	}
	for _, sg := range res.PossibleSupersedes {
		if err = s.st.AddReview(out.Project, out.ID, sg.Note.ID, sg.Cosine); err != nil {
			return res, err
		}
	}
	_ = s.st.MarkBriefStale(out.Project)
	if vec != nil {
		if err = s.st.SetVector(out.ID, s.r.emb.Model(), vec); err != nil {
			return res, err
		}
	} else {
		s.index(out)
	}
	return res, nil
}

// Reviews lists the pending supersession suggestions of a project (all projects when empty).
func (s *Service) Reviews(ctx context.Context, a Actor, project string) (out []ReviewItem, err error) {
	start := s.now()
	defer func() { s.record(a, "review", project, start, err) }()
	if project != "" && !ValidProject(project) {
		return nil, bad("project name must match %s", projectRe)
	}
	return s.st.pendingReviews(project)
}

// ResolveReview applies a suggestion (the older note becomes superseded by the newer one) or dismisses it.
func (s *Service) ResolveReview(ctx context.Context, a Actor, id int64, apply bool) (err error) {
	start := s.now()
	project := ""
	defer func() { s.record(a, "review.resolve", project, start, err) }()
	if project, err = s.st.resolveReview(id, apply); err != nil {
		return err
	}
	return s.st.MarkBriefStale(project)
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// Handoff stores what an agent was doing as one state note that replaces the project's previous handoff, and
// regenerates the brief so the next reader sees it at once.
func (s *Service) Handoff(ctx context.Context, a Actor, in HandoffIn) (out Note, err error) {
	start := s.now()
	defer func() { s.record(a, "handoff", in.Project, start, err) }()
	if !ValidProject(in.Project) {
		return Note{}, bad("project name must match %s", projectRe)
	}
	sum := strings.Join(strings.Fields(in.Summary), " ")
	if sum == "" || runes(sum) > 1000 {
		return Note{}, bad("summary must be 1-1000 characters")
	}
	if len(in.OpenTasks) > 30 || len(in.NextSteps) > 30 {
		return Note{}, bad("at most 30 open tasks and 30 next steps")
	}
	agent := clipRunes(strings.Join(strings.Fields(in.Agent), " "), 40)
	if agent == "" {
		agent = a.Agent
	}
	if agent == "" {
		agent = "unknown"
	}
	body := sum
	if !strings.HasSuffix(body, ".") && !strings.HasSuffix(body, "!") && !strings.HasSuffix(body, "?") {
		body += "."
	}
	for _, part := range []struct {
		label string
		items []string
	}{{"Open tasks", in.OpenTasks}, {"Next steps", in.NextSteps}} {
		var xs []string
		for _, it := range part.items {
			if it = strings.Join(strings.Fields(it), " "); it != "" {
				xs = append(xs, clipRunes(it, 200))
			}
		}
		if len(xs) > 0 {
			body += " " + part.label + ": " + strings.Join(xs, "; ") + "."
		}
	}
	prev, err := s.st.ListNotes(NoteFilter{Project: in.Project, Kind: "state"})
	if err != nil {
		return Note{}, err
	}
	n := Note{Project: in.Project, Kind: "state", Title: "Handoff from " + agent + " " + start.UTC().Format("2006-01-02"), Body: body,
		Importance: 4, Confidence: 0.9, SourceAgent: agent, SourceChunk: "handoff"}
	if out, err = s.st.AddNote(n); err != nil {
		return Note{}, err
	}
	for _, p := range prev {
		if p.SourceChunk == "handoff" {
			if err = s.st.Supersede(p.ID, out.ID); err != nil {
				return out, err
			}
		}
	}
	s.index(out)
	if err = s.RegenerateBrief(ctx, in.Project); err != nil {
		_ = s.st.MarkBriefStale(in.Project)
	}
	return out, nil
}

// Retract takes a note out of recall and out of the next brief.
func (s *Service) Retract(ctx context.Context, a Actor, id string) (err error) {
	start := s.now()
	project := ""
	defer func() { s.record(a, "retract", project, start, err) }()
	n, ok, err := s.st.GetNote(id)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	project = n.Project
	st := "retracted"
	if err = s.st.UpdateNote(id, NotePatch{Status: &st}); err != nil {
		return err
	}
	return s.st.MarkBriefStale(n.Project)
}

// ConfirmNote upgrades a note's epistemic status (speculative to inferred, anything to observed) and records that it was
// seen to be true. Observed needs a person or a token with scope memory/observe; nothing is ever downgraded.
func (s *Service) ConfirmNote(ctx context.Context, a Actor, id, to string) (out Note, err error) {
	start := s.now()
	project := ""
	defer func() { s.record(a, "confirm", project, start, err) }()
	if to != Inferred && to != Observed {
		return Note{}, bad("epistemic must be inferred or observed")
	}
	if to == Observed && !a.CanObserve {
		return Note{}, bad("only a person (the console) or a token with scope memory/observe may confirm a note as observed")
	}
	n, ok, err := s.st.GetNote(id)
	if err != nil {
		return Note{}, err
	}
	if !ok {
		return Note{}, ErrNotFound
	}
	project = n.Project
	rank := map[string]int{Speculative: 0, Inferred: 1, Observed: 2}
	if rank[to] < rank[n.Epistemic] {
		return Note{}, bad("a %s note cannot be downgraded to %s", n.Epistemic, to)
	}
	if err = s.st.SetEpistemic(id, to); err != nil {
		return Note{}, err
	}
	_ = s.st.MarkBriefStale(n.Project)
	n.Epistemic = to
	return n, nil
}

// Forwardable reports whether a note may be sent on to Hindsight: speculative notes never are.
func Forwardable(n Note) bool { return n.Epistemic != Speculative }

// Patch changes a note's fields; any status change marks the brief stale.
func (s *Service) Patch(ctx context.Context, a Actor, id string, p NotePatch) (err error) {
	start := s.now()
	project := ""
	defer func() { s.record(a, "update", project, start, err) }()
	n, ok, err := s.st.GetNote(id)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	project = n.Project
	if err = s.st.UpdateNote(id, p); err != nil {
		return err
	}
	return s.st.MarkBriefStale(n.Project)
}

// Notes lists notes for the console and the API.
func (s *Service) Notes(a Actor, f NoteFilter) (out []Note, err error) {
	start := s.now()
	defer func() { s.record(a, "notes", f.Project, start, err) }()
	if f.Project != "" && !ValidProject(f.Project) {
		return nil, bad("project name must match %s", projectRe)
	}
	if f.Kind != "" && !kinds[f.Kind] {
		return nil, bad("unknown kind %q", f.Kind)
	}
	if f.Status != "" && f.Status != "any" && !statuses[f.Status] {
		return nil, bad("unknown status %q", f.Status)
	}
	return s.st.ListNotes(f)
}

func (s *Service) Projects(a Actor) (out []ProjectRow, err error) {
	start := s.now()
	defer func() { s.record(a, "projects", "", start, err) }()
	return s.st.Projects()
}

// Status counts what the store holds; with a project it adds what the newest session of that project was sent.
func (s *Service) Status(a Actor, project string) (v StatusView, err error) {
	start := s.now()
	defer func() { s.record(a, "status", project, start, err) }()
	if v.Projects, v.Notes, v.Briefs, err = s.st.Counts(); err != nil {
		return v, err
	}
	if project == "" {
		return v, nil
	}
	if project, err = s.resolve(project); err != nil {
		return v, err
	}
	b, ok, err := s.st.GetBrief(project)
	if err != nil || !ok {
		return v, err
	}
	d, ok, err := s.st.LastDelivery(project)
	if err != nil || !ok {
		return v, err
	}
	got, err := s.st.DeliveredPages(project, d.Agent, d.Session, b.Version)
	if err != nil {
		return v, err
	}
	have, missing := deliveredSplit(got, deliveryUniverse(b))
	v.Delivery = &DeliveryView{Agent: d.Agent, Session: d.Session, At: d.At, Version: b.Version, Delivered: nonNilStrings(have), NotDelivered: nonNilStrings(missing)}
	return v, nil
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
