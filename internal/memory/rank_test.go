package memory

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeEmb struct {
	vecs  map[string][]float32
	fail  bool
	delay time.Duration
}

func (f fakeEmb) Model() string { return "fake" }
func (f fakeEmb) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if f.fail {
		return nil, context.DeadlineExceeded
	}
	select {
	case <-time.After(f.delay):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v, ok := f.vecs[t]
		if !ok {
			v = []float32{0, 0, 1}
		}
		out[i] = v
	}
	return out, nil
}

func TestRecallFusesFTSAndVectorsAndSurvivesADeadEmbedder(t *testing.T) {
	s := newStore(t)
	s.UpsertProject("p", "")
	a, _ := s.AddNote(Note{Project: "p", Kind: "howto", Title: "Run the gate", Body: "bash dev/gate.sh runs the Go tests on the VDS", SourceAgent: "t"})
	b, _ := s.AddNote(Note{Project: "p", Kind: "finding", Title: "TEI is heavy", Body: "the embeddings container uses 851 MiB", SourceAgent: "t"})
	emb := fakeEmb{vecs: map[string][]float32{
		a.Title + "\n" + a.Body: {1, 0, 0},
		b.Title + "\n" + b.Body: {0, 1, 0},
		"how do I run tests":    {0.9, 0.1, 0},
		"memory usage":          {0.1, 0.9, 0},
	}}
	r := &Ranker{st: s, emb: emb}
	for _, n := range []Note{a, b} {
		if err := r.Index(context.Background(), n); err != nil {
			t.Fatal(err)
		}
	}
	hits, err := rhits(r, context.Background(), RecallQuery{Project: "p", Query: "how do I run tests"})
	if err != nil || len(hits) == 0 || hits[0].ID != a.ID || hits[0].Score != 1 {
		t.Fatalf("semantic+fts: %+v %v", hits, err)
	}
	hits, _ = rhits(r, context.Background(), RecallQuery{Project: "p", Query: "memory usage"})
	if len(hits) == 0 || hits[0].ID != b.ID {
		t.Fatalf("vector-only match (no shared words) must still rank first: %+v", hits)
	}
	dead := &Ranker{st: s, emb: fakeEmb{fail: true}}
	start := time.Now()
	hits, err = rhits(dead, context.Background(), RecallQuery{Project: "p", Query: "gate"})
	if err != nil || len(hits) != 1 || hits[0].ID != a.ID || time.Since(start) > time.Second {
		t.Fatalf("fts fallback: %+v %v in %s", hits, err, time.Since(start))
	}
	slow := &Ranker{st: s, emb: fakeEmb{delay: 5 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if hits, err = rhits(slow, ctx, RecallQuery{Project: "p", Query: "gate"}); err != nil || len(hits) != 1 {
		t.Fatalf("a slow embedder must not block recall: %+v %v", hits, err)
	}
	if hits, _ := rhits(r, context.Background(), RecallQuery{Project: "p", Query: "gate", Kinds: []string{"finding"}}); len(hits) != 0 {
		t.Fatal("kind filter applies to both arms")
	}
	if hits, _ := rhits((&Ranker{st: s}), context.Background(), RecallQuery{Project: "p", Query: "gate"}); len(hits) != 1 {
		t.Fatal("a ranker without an embedder is FTS-only")
	}
}

func TestEmbedderFailuresAreLoggedAtMostOncePerMinute(t *testing.T) {
	var l rateLimitedLogger
	t0 := time.Unix(1_800_000_000, 0)
	n := 0
	for i := 0; i < 200; i++ {
		if l.allow(t0.Add(time.Duration(i) * 100 * time.Millisecond)) {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("one log line in the first 20 s, got %d", n)
	}
	if !l.allow(t0.Add(61 * time.Second)) {
		t.Fatal("and another a minute later")
	}
}

func TestTEIClientSpeaksTheOpenAIEmbeddingsShape(t *testing.T) {
	var gotAuth, gotBody, gotPath string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte(`{"data":[{"index":1,"embedding":[0.3,0.4]},{"index":0,"embedding":[0.1,0.2]}],"model":"m"}`))
	}))
	defer ts.Close()
	e := NewTEI(ts.URL+"/", "tei-key", "m", ts.Client())
	v, err := e.Embed(context.Background(), []string{"a", "b"})
	if err != nil || len(v) != 2 || v[1][1] != 0.4 || v[0][0] != 0.1 || gotAuth != "Bearer tei-key" || gotBody != `{"input":["a","b"],"model":"m"}` || gotPath != "/v1/embeddings" {
		t.Fatalf("%v %v %q %q %q", v, err, gotAuth, gotBody, gotPath)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", 503) }))
	defer bad.Close()
	if _, err := NewTEI(bad.URL, "", "m", bad.Client()).Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("an HTTP error must be returned")
	}
	short := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"data":[]}`)) }))
	defer short.Close()
	if _, err := NewTEI(short.URL, "", "m", short.Client()).Embed(context.Background(), []string{"a"}); err == nil {
		t.Fatal("a short answer must be an error")
	}
}

func rhits(r *Ranker, ctx context.Context, q RecallQuery) ([]Scored, error) {
	res, err := r.Recall(ctx, q)
	return res.Hits, err
}
