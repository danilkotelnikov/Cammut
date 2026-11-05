package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"strings"
	"testing"
	"unicode"
)

// The golden set is synthetic: 24 invented notes about an invented build tool and 40 queries, 20 on topic (with the
// notes that must come back) and 20 off topic (that must return nothing). It runs in `go test`, once with full-text
// search alone and once with a deterministic stand-in embedder, so a change to the relevance gate that lets noise in
// or loses a real hit fails the build. GOLDEN_REPORT=1 prints the numbers.

type goldenNote struct{ Key, Kind, Title, Body string }
type goldenQuery struct {
	Q            string   `json:"q"`
	Expect       []string `json:"expect"`
	NeedsVectors bool     `json:"needs_vectors"`
}

func loadGolden(t *testing.T) ([]goldenNote, []goldenQuery) {
	t.Helper()
	var notes []goldenNote
	var qs []goldenQuery
	for file, dst := range map[string]any{"testdata/golden/notes.json": &notes, "testdata/golden/queries.json": &qs} {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, dst); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
	}
	return notes, qs
}

// conceptEmb is a stand-in for a sentence-embedding model: every word is hashed into 4096 dimensions, and words that
// belong to a topic of the lexicon below also light up that topic's dimension, so a paraphrase lands near the note
// it paraphrases. Ambiguous words ("deploy", "log", "token", "build", "migrations") are deliberately NOT in the
// lexicon, because a decent model tells "deploy a parachute" from "deploy to staging" by context. Deterministic and
// offline: it exercises the thresholds, it proves nothing about a real model.
type conceptEmb struct{}

var goldenConcepts = map[string]string{}

func init() {
	for topic, words := range map[string]string{
		"cache":     "cache compiled artifact prune location",
		"deploy":    "ship staging production release approver rollout",
		"retry":     "retry backoff exponential resilience timeout",
		"logging":   "json trace fields lines",
		"schema":    "schema database applied filename",
		"auth":      "access refresh expire expiry session login lifetime",
		"review":    "review pull request approval approvals checks",
		"naming":    "naming names lowercase singular convention spec",
		"flaky":     "flaky intermittent intermittently quarantine retried unstable",
		"runner":    "runner cpu cpus memory sizing",
		"flags":     "feature flag toggle",
		"ratelimit": "rate limit throttled throttling quota requests",
		"i18n":      "translation translator locale strings english",
		"images":    "image resized resize webp pixels upload",
		"metrics":   "metric dashboard latency alerts observability",
		"oncall":    "oncall rotation rotates handover engineer reachable",
		"backup":    "backup snapshot nightly dump kept retained",
		"paging":    "pagination page cursor endpoints items",
		"errors":    "error code conflict",
		"deps":      "dependency lockfile pinned bot",
		"security":  "security headers hsts policy sniffing",
		"time":      "timezone timestamps utc zone",
		"monorepo":  "monorepo repository repo tooling single",
		"commit":    "commit message mood imperative git",
	} {
		for _, w := range strings.Fields(words) {
			goldenConcepts[w] = topic
		}
	}
}

func (conceptEmb) Model() string { return "concept" }
func (conceptEmb) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v := make([]float32, 4096)
		add := func(s string, w float32) {
			h := fnv.New32a()
			h.Write([]byte(s))
			v[h.Sum32()%4096] += w
		}
		add("common-mode", 1.2) // real models give unrelated texts a small positive cosine
		for _, w := range contentTerms(t) {
			w = strings.TrimSuffix(w, "s")
			add(w, 1)
			if topic, ok := goldenConcepts[w]; ok {
				add("topic:"+topic, 2.5)
			}
			for j := 0; j+3 <= len(w); j++ {
				add("#"+w[j:j+3], 0.1)
			}
		}
		out[i] = v
	}
	return out, nil
}

type goldenReport struct {
	onTopic, found, expected, returned, relevant int
	offTopic, falsePositives                     int
	missed                                       []string
}

func (r goldenReport) precision() float64 {
	return float64(r.relevant) / math.Max(1, float64(r.returned))
}
func (r goldenReport) recall() float64 { return float64(r.found) / math.Max(1, float64(r.expected)) }
func (r goldenReport) String() string {
	return fmt.Sprintf("precision=%.2f recall=%.2f (%d/%d expected notes) off-topic false positives=%d/%d", r.precision(), r.recall(), r.found, r.expected, r.falsePositives, r.offTopic)
}

func runGolden(t *testing.T, vectors bool) goldenReport {
	t.Helper()
	notes, qs := loadGolden(t)
	st := newStore(t)
	var rk *Ranker
	if vectors {
		rk = &Ranker{emb: conceptEmb{}}
	} else {
		rk = &Ranker{}
	}
	svc := NewService(st, rk, nil, nil)
	for _, n := range notes {
		if _, err := svc.Remember(ctx, actor, Note{Project: "g", Kind: n.Kind, Key: n.Key, Title: n.Title, Body: n.Body}); err != nil {
			t.Fatal(err)
		}
	}
	svc.Wait()
	var rep goldenReport
	for _, q := range qs {
		hits, err := svc.Recall(ctx, actor, RecallQuery{Project: "g", Query: q.Q})
		if err != nil {
			t.Fatalf("%q: %v", q.Q, err)
		}
		got := map[string]bool{}
		for _, h := range hits {
			got[h.Key] = true
		}
		if len(q.Expect) == 0 {
			rep.offTopic++
			if len(hits) > 0 {
				rep.falsePositives++
				rep.missed = append(rep.missed, "false positive: "+q.Q)
			}
			continue
		}
		if q.NeedsVectors && !vectors {
			continue
		}
		rep.onTopic++
		rep.returned += len(hits)
		for _, k := range q.Expect {
			rep.expected++
			if got[k] {
				rep.found++
			} else {
				rep.missed = append(rep.missed, "missed "+k+": "+q.Q)
			}
		}
		for _, h := range hits {
			for _, k := range q.Expect {
				if h.Key == k {
					rep.relevant++
				}
			}
		}
	}
	return rep
}

func TestGoldenSetFullTextOnly(t *testing.T) {
	rep := runGolden(t, false)
	t.Logf("golden fts-only: %s", rep)
	if os.Getenv("GOLDEN_REPORT") != "" {
		fmt.Printf("GOLDEN fts-only: %s\n", rep)
	}
	for _, m := range rep.missed {
		t.Error(m)
	}
	if rep.precision() < 0.9 {
		t.Errorf("precision %.2f", rep.precision())
	}
}

func TestGoldenSetWithEmbeddings(t *testing.T) {
	rep := runGolden(t, true)
	t.Logf("golden fts+vectors: %s", rep)
	if os.Getenv("GOLDEN_REPORT") != "" {
		fmt.Printf("GOLDEN fts+vectors: %s\n", rep)
	}
	for _, m := range rep.missed {
		t.Error(m)
	}
	if rep.precision() < 0.9 {
		t.Errorf("precision %.2f", rep.precision())
	}
}

// contentTerms is the golden harness's tokenizer; the real one is shared with the ranker (see relevance.go).
var _ = unicode.IsLetter
