package memory

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// RecallQuery asks for the notes of one project that match Query. Limit defaults to 6 and is capped at 25.
type RecallQuery struct {
	Project, Query     string
	Kinds              []string
	Limit              int
	Since              time.Time
	IncludeSpeculative bool     // speculative notes are returned only when asked for
	Refs               []string // service level: whole notes by ref, ignoring Query
	Pages              []string // service level: whole pages by id
}

const (
	rrfK         = 60
	candidates   = 50
	tightFactor  = 0.15
	vectorBudget = 2 * time.Second
	logEvery     = time.Minute
)

// Abstained is the value of RecallResult.Abstained when the relevance gate held back every candidate.
const Abstained = "below_threshold"

// RecallResult is the answer to a text query: the hits, or an explicit abstention. Abstained is "" or "below_threshold".
type RecallResult struct {
	Hits      []Scored
	Abstained string
}

// Ranker fuses full-text and vector search behind a relevance gate (see Gate). The vector arm is optional and fail-open.
type Ranker struct {
	st    *Store
	emb   Embedder
	log   *slog.Logger
	lim   rateLimitedLogger
	Gate  Gate  // zero value = DefaultGate
	Dedup Dedup // write-time duplicate and supersession thresholds; zero value = DefaultDedup
}

// NewRanker returns a ranker over st; emb may be nil (recall is then FTS-only).
func NewRanker(st *Store, emb Embedder, log *slog.Logger) *Ranker {
	return &Ranker{st: st, emb: emb, log: log}
}

// rateLimitedLogger lets a failing dependency log once a minute instead of once per request.
type rateLimitedLogger struct {
	mu   sync.Mutex
	last time.Time
}

func (l *rateLimitedLogger) allow(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.last.IsZero() && now.Sub(l.last) < logEvery {
		return false
	}
	l.last = now
	return true
}

func (r *Ranker) warn(what string, err error) {
	if !r.lim.allow(time.Now()) {
		return
	}
	log := r.log
	if log == nil {
		log = slog.Default()
	}
	log.Warn("memory: "+what+" (FTS-only until it recovers; logged at most once a minute)", "err", err.Error())
}

type vecResult struct {
	ids []string           // best first
	cos map[string]float64 // cosine of every id in ids
	err error
}

// Recall returns the fused hits, best first, with Score normalised to the top hit, or an abstention when nothing
// clears the relevance gate.
func (r *Ranker) Recall(ctx context.Context, q RecallQuery) (RecallResult, error) {
	hits, err := r.recall(ctx, q)
	if err != nil {
		return RecallResult{}, err
	}
	if len(hits) == 0 && strings.TrimSpace(q.Query) != "" {
		return RecallResult{Abstained: Abstained}, nil
	}
	return RecallResult{Hits: hits}, nil
}

func (r *Ranker) recall(ctx context.Context, q RecallQuery) ([]Scored, error) {
	terms := contentTerms(q.Query)
	if len(terms) == 0 { // nothing but function words: there is nothing to match on
		return nil, nil
	}
	g := r.Gate.orDefault()
	limit := q.Limit
	if limit <= 0 {
		limit = 6
	}
	if limit > 25 {
		limit = 25
	}
	var vch chan vecResult
	var vctx context.Context
	if r.emb != nil {
		var cancel context.CancelFunc
		vctx, cancel = context.WithTimeout(ctx, vectorBudget)
		defer cancel()
		vch = make(chan vecResult, 1)
		go func() {
			ids, cos, err := r.vectorArm(vctx, q, g.MinFloor)
			vch <- vecResult{ids, cos, err}
		}()
	}
	fts, err := r.st.SearchFTS(q.Project, strings.Join(terms, " "), q.Kinds, candidates)
	if err != nil {
		return nil, err
	}
	notes := map[string]Note{}
	fused := map[string]float64{}
	lexical := map[string]bool{} // enough of the query's words occur in the note
	matched := map[string]int{}
	need := g.lexicalNeed(len(terms))
	for i, h := range fts {
		notes[h.ID] = h.Note
		fused[h.ID] += 1.0 / float64(rrfK+i+1)
		matched[h.ID] = termsMatched(terms, h.Note)
		lexical[h.ID] = matched[h.ID] >= need
	}
	var cos map[string]float64
	if vch != nil {
		select {
		case v := <-vch:
			if v.err != nil {
				r.warn("embeddings unavailable", v.err)
			}
			cos = v.cos
			for i, id := range v.ids {
				if _, ok := notes[id]; !ok {
					n, found, err := r.st.GetNote(id)
					if err != nil || !found {
						continue
					}
					notes[id] = n
					matched[id] = termsMatched(terms, n)
					lexical[id] = matched[id] >= need
				}
				fused[id] += 1.0 / float64(rrfK+i+1)
			}
		case <-vctx.Done():
			r.warn("embeddings too slow", vctx.Err())
		}
	}
	tau, best := g.threshold(q.Query, len(terms), cos), 0.0
	topID := ""
	for id, c := range cos {
		if c > best || (c == best && id < topID) {
			best, topID = c, id
		}
	}
	out := make([]Scored, 0, len(fused))
	for id, sc := range fused {
		n := notes[id]
		// The gate: a note is returned when enough of the query's words occur in it, or when its vector is close
		// enough (tau; lower for the single best note when it clearly leads), or when both arms agree (one word
		// occurs and the similarity is only a little lower). A note that merely sits near a clear winner is not added.
		c, hasVec := cos[id]
		bar := tau
		if id == topID {
			bar = g.leadThreshold(tau, cos)
		}
		pass := lexical[id] || (hasVec && c >= bar) || (hasVec && matched[id] >= 1 && c >= tau-g.AgreeRelax)
		if pass && !lexical[id] && g.dominated(c, best) {
			pass = false
		}
		if !pass {
			continue
		}
		if !q.Since.IsZero() && n.UpdatedAt.Before(q.Since) {
			continue
		}
		if n.Epistemic == Speculative && !q.IncludeSpeculative {
			continue
		}
		out = append(out, Scored{Note: n, Score: sc})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].ID < out[j].ID
	})
	if len(out) == 0 {
		return nil, nil
	}
	top := out[0].Score
	for i := range out {
		out[i].Score /= top
	}
	if len(out) > limit {
		out = out[:limit]
	}
	if len(out) > 3 {
		keep := 3
		for keep < len(out) && out[keep].Score >= tightFactor {
			keep++
		}
		out = out[:keep]
	}
	return out, nil
}

// vectorArm returns the project's note ids whose cosine to the query is at least floor, best first, with the cosines.
func (r *Ranker) vectorArm(ctx context.Context, q RecallQuery, floor float64) ([]string, map[string]float64, error) {
	qv, err := r.emb.Embed(ctx, []string{q.Query})
	if err != nil {
		return nil, nil, err
	}
	if len(qv) != 1 {
		return nil, nil, nil
	}
	rows, err := r.st.Vectors(q.Project)
	if err != nil {
		return nil, nil, err
	}
	kinds := map[string]bool{}
	for _, k := range q.Kinds {
		kinds[k] = true
	}
	type cand struct {
		id  string
		cos float64
	}
	var cs []cand
	model := r.emb.Model()
	for _, row := range rows {
		if row.Model != model || (len(kinds) > 0 && !kinds[row.Kind]) {
			continue
		}
		if c := cosine(qv[0], row.Vec); c >= floor {
			cs = append(cs, cand{row.NoteID, c})
		}
	}
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].cos != cs[j].cos {
			return cs[i].cos > cs[j].cos
		}
		return cs[i].id < cs[j].id
	})
	if len(cs) > candidates {
		cs = cs[:candidates]
	}
	ids := make([]string, len(cs))
	cos := make(map[string]float64, len(cs))
	for i, c := range cs {
		ids[i] = c.id
		cos[c.id] = c.cos
	}
	return ids, cos, nil
}

func cosine(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

// Index embeds a note and stores its vector; a ranker without an embedder does nothing.
func (r *Ranker) Index(ctx context.Context, n Note) error {
	if r.emb == nil {
		return nil
	}
	v, err := r.emb.Embed(ctx, []string{n.Title + "\n" + n.Body})
	if err != nil {
		return err
	}
	if len(v) != 1 {
		return nil
	}
	return r.st.SetVector(n.ID, r.emb.Model(), v[0])
}
