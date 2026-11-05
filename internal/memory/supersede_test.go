package memory

import (
	"errors"
	"fmt"
	"testing"
)

// vec returns a unit vector at the given cosine to {1,0,0}.
func vec(cos float32) []float32 {
	rest := float64(1 - cos*cos)
	var s float32
	for float64(s*s) < rest {
		s += 0.0001
	}
	return []float32{cos, s, 0}
}

func newDedupService(t *testing.T, vecs map[string][]float32) *Service {
	t.Helper()
	return NewService(newStore(t), &Ranker{emb: fakeEmb{vecs: vecs}}, nil, nil)
}

func text(title, body string) string { return title + "\n" + body }

func TestNearDuplicateIsNotStoredUnlessForced(t *testing.T) {
	svc := newDedupService(t, map[string][]float32{
		text("Use FTS5", "it ships in the driver"):            {1, 0, 0},
		text("Use FTS5 for search", "it ships in the driver"): vec(0.95),
	})
	a, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "decision", Title: "Use FTS5", Body: "it ships in the driver"})
	if err != nil {
		t.Fatal(err)
	}
	svc.Wait()
	out, err := svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "decision", Title: "Use FTS5 for search", Body: "it ships in the driver"}, RememberOpts{})
	if err != nil || out.Duplicate == nil || out.Duplicate.ID != a.ID || out.Note.ID != "" {
		t.Fatalf("duplicate: %+v %v", out, err)
	}
	if n, _ := svc.st.CountActive("p"); n != 1 {
		t.Fatalf("a duplicate is not stored: %d active", n)
	}
	out, err = svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "decision", Title: "Use FTS5 for search", Body: "it ships in the driver"}, RememberOpts{Force: true})
	if err != nil || out.Duplicate != nil || out.Note.ID == "" {
		t.Fatalf("forced: %+v %v", out, err)
	}
}

func TestACloseButNotIdenticalNoteIsStoredAndQueuedForReviewNeverAutoApplied(t *testing.T) {
	svc := newDedupService(t, map[string][]float32{
		text("Deploy host", "the app runs on host alpha"): {1, 0, 0},
		text("Deploy host", "the app runs on host beta"):  vec(0.88),
		text("Version", "version 0.2.0 is deployed"):      {0, 1, 0},
		text("Version", "version 0.3.0 is deployed"):      {0, 0.95, 0.31},
	})
	a, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Title: "Deploy host", Body: "the app runs on host alpha"})
	svc.Wait()
	out, err := svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "state", Title: "Deploy host", Body: "the app runs on host beta"}, RememberOpts{})
	if err != nil || out.Note.ID == "" || len(out.PossibleSupersedes) != 1 || out.PossibleSupersedes[0].Note.ID != a.ID || out.PossibleSupersedes[0].Cosine < 0.85 {
		t.Fatalf("candidate: %+v %v", out, err)
	}
	if old, _, _ := svc.st.GetNote(a.ID); old.Status != "active" {
		t.Fatal("never auto-applied: the old note stays active")
	}
	// numbers that differ make a near-identical note an update, not a duplicate
	v1, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Title: "Version", Body: "version 0.2.0 is deployed"})
	svc.Wait()
	out, err = svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "state", Title: "Version", Body: "version 0.3.0 is deployed"}, RememberOpts{})
	if err != nil || out.Duplicate != nil || len(out.PossibleSupersedes) == 0 || out.PossibleSupersedes[0].Note.ID != v1.ID {
		t.Fatalf("version bump: %+v %v", out, err)
	}
	items, err := svc.Reviews(ctx, actor, "p")
	if err != nil || len(items) != 2 {
		t.Fatalf("review queue: %+v %v", items, err)
	}
}

func TestSuggestionsStayInsideTheProjectTheKindAndTheAgent(t *testing.T) {
	same := text("Same text", "identical body")
	svc := newDedupService(t, map[string][]float32{same: {1, 0, 0}})
	other := Actor{Agent: "mcp:other", TokenID: 9}
	if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "decision", Title: "Same text", Body: "identical body"}); err != nil {
		t.Fatal(err)
	}
	svc.Wait()
	for name, c := range map[string]struct {
		a    Actor
		note Note
	}{
		"other project": {actor, Note{Project: "q", Kind: "decision", Title: "Same text", Body: "identical body"}},
		"other kind":    {actor, Note{Project: "p", Kind: "finding", Title: "Same text", Body: "identical body"}},
		"other agent":   {other, Note{Project: "p", Kind: "decision", Title: "Same text", Body: "identical body"}},
	} {
		out, err := svc.RememberFull(ctx, c.a, c.note, RememberOpts{})
		if err != nil || out.Duplicate != nil || len(out.PossibleSupersedes) != 0 || out.Note.ID == "" {
			t.Errorf("%s: %+v %v", name, out, err)
		}
	}
}

func TestKeyedNotesAndExplicitSupersedesSkipTheNeighbourCheck(t *testing.T) {
	same := text("Same text", "identical body")
	svc := newDedupService(t, map[string][]float32{same: {1, 0, 0}})
	a, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Title: "Same text", Body: "identical body"})
	svc.Wait()
	out, err := svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "state", Key: "k", Title: "Same text", Body: "identical body"}, RememberOpts{})
	if err != nil || out.Duplicate != nil || out.Note.ID == "" || len(out.PossibleSupersedes) != 0 {
		t.Fatalf("keyed: %+v %v", out, err)
	}
	out, err = svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "state", Supersedes: a.ID, Title: "Same text", Body: "identical body"}, RememberOpts{})
	if err != nil || out.Duplicate != nil || out.Note.ID == "" {
		t.Fatalf("explicit supersedes: %+v %v", out, err)
	}
}

func TestOnlyTheThreeNearestAreSuggestedAndADeadEmbedderStoresTheNote(t *testing.T) {
	vecs := map[string][]float32{text("New", "fresh"): {1, 0, 0}}
	for i, c := range []float32{0.9, 0.89, 0.88, 0.87} {
		vecs[text(fmt.Sprintf("Old%d", i), "body")] = vec(c)
	}
	svc := newDedupService(t, vecs)
	for i := 0; i < 4; i++ {
		if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: fmt.Sprintf("Old%d", i), Body: "body"}); err != nil {
			t.Fatal(err)
		}
	}
	svc.Wait()
	out, err := svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "finding", Title: "New", Body: "fresh"}, RememberOpts{})
	if err != nil || len(out.PossibleSupersedes) != 3 || out.PossibleSupersedes[0].Cosine < out.PossibleSupersedes[2].Cosine {
		t.Fatalf("top three, best first: %+v %v", out, err)
	}
	dead := NewService(newStore(t), &Ranker{emb: fakeEmb{fail: true}}, nil, nil)
	out, err = dead.RememberFull(ctx, actor, Note{Project: "p", Kind: "finding", Title: "New", Body: "fresh"}, RememberOpts{})
	if err != nil || out.Note.ID == "" || out.Duplicate != nil {
		t.Fatalf("fail open: %+v %v", out, err)
	}
}

func TestAPersonAppliesOrDismissesASuggestion(t *testing.T) {
	svc := newDedupService(t, map[string][]float32{
		text("Host", "alpha"): {1, 0, 0},
		text("Host", "beta"):  vec(0.88),
		text("Port", "80"):    {0, 1, 0},
		text("Port", "81"):    {0, 0.88, 0.475},
	})
	a, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Title: "Host", Body: "alpha"})
	c, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Title: "Port", Body: "80"})
	svc.Wait()
	svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "state", Title: "Host", Body: "beta"}, RememberOpts{})
	svc.RememberFull(ctx, actor, Note{Project: "p", Kind: "state", Title: "Port", Body: "81"}, RememberOpts{})
	items, _ := svc.Reviews(ctx, human, "p")
	if len(items) != 2 {
		t.Fatalf("%+v", items)
	}
	var host, port ReviewItem
	for _, it := range items {
		if it.Candidate.ID == a.ID {
			host = it
		} else if it.Candidate.ID == c.ID {
			port = it
		}
	}
	if err := svc.ResolveReview(ctx, human, host.ID, true); err != nil {
		t.Fatal(err)
	}
	if old, _, _ := svc.st.GetNote(a.ID); old.Status != "superseded" || old.SupersededBy != host.Note.ID {
		t.Fatalf("applied: %+v", old)
	}
	if err := svc.ResolveReview(ctx, human, port.ID, false); err != nil {
		t.Fatal(err)
	}
	if old, _, _ := svc.st.GetNote(c.ID); old.Status != "active" {
		t.Fatal("dismissed leaves both notes alone")
	}
	if left, _ := svc.Reviews(ctx, human, "p"); len(left) != 0 {
		t.Fatalf("resolved items leave the queue: %+v", left)
	}
	if err := svc.ResolveReview(ctx, human, host.ID, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resolving twice: %v", err)
	}
	if err := svc.ResolveReview(ctx, actor, 12345, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}
