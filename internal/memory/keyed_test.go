package memory

import (
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestKeyedStateNoteSupersedesThePreviousVersionAndHistoryKeepsBoth(t *testing.T) {
	svc, _ := newService(t)
	v1, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: "cammut.deployed", Title: "Cammut deployed", Body: "version 0.2.0 is deployed"})
	if err != nil {
		t.Fatal(err)
	}
	v2, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: "cammut.deployed", Title: "Cammut deployed", Body: "version 0.3.0 is deployed"})
	if err != nil {
		t.Fatal(err)
	}
	if v2.Supersedes != v1.ID {
		t.Fatalf("the new note must point at the old one: %+v", v2)
	}
	old, _, _ := svc.st.GetNote(v1.ID)
	if old.Status != "superseded" || old.SupersededBy != v2.ID {
		t.Fatalf("old note: %+v", old)
	}
	br, err := svc.Brief(ctx, actor, "p", BriefRequest{Tier: "full"})
	if err != nil || !strings.Contains(br.Body, "0.3.0") || strings.Contains(br.Body, "0.2.0") {
		t.Fatalf("brief must show only 0.3.0: %q %v", br.Body, err)
	}
	hits, err := svc.Recall(ctx, actor, RecallQuery{Project: "p", Query: "deployed version"})
	if err != nil || len(hits) != 1 || hits[0].ID != v2.ID {
		t.Fatalf("recall must return only the current note: %+v %v", hits, err)
	}
	h, err := svc.History(ctx, actor, "p", "cammut.deployed")
	if err != nil || len(h) != 2 || h[0].ID != v2.ID || h[1].ID != v1.ID || h[1].Status != "superseded" {
		t.Fatalf("history must list both, newest first: %+v %v", h, err)
	}
	if _, err := svc.History(ctx, actor, "p", "no.such.key"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown key: %v", err)
	}
}

func TestKeysAreScopedToTheProjectAndValidated(t *testing.T) {
	svc, _ := newService(t)
	a, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: "k.one", Title: "A", Body: "a"})
	b, err := svc.Remember(ctx, actor, Note{Project: "q", Kind: "state", Key: "k.one", Title: "B", Body: "b"})
	if err != nil || b.Supersedes != "" {
		t.Fatalf("same key in another project is independent: %+v %v", b, err)
	}
	if n, _, _ := svc.st.GetNote(a.ID); n.Status != "active" {
		t.Fatal("project p note must stay active")
	}
	for _, k := range []string{"has space", "x\ny", strings.Repeat("k", 81), "-lead"} {
		if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: k, Title: "t", Body: "b"}); !errors.Is(err, ErrBadInput) {
			t.Fatalf("key %q must be refused: %v", k, err)
		}
	}
}

func TestOnlyOneActiveNoteHoldsAKeyUnderConcurrentWrites(t *testing.T) {
	svc, _ := newService(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: "race", Title: "t", Body: strings.Repeat("x", i+1)})
		}(i)
	}
	wg.Wait()
	var n int
	if err := svc.st.db.QueryRow(`SELECT count(*) FROM mem_notes WHERE project='p' AND note_key='race' AND status='active'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("active holders of the key: %d %v", n, err)
	}
}

func TestReactivatingARetractedNoteWhoseKeyIsTakenIsRefused(t *testing.T) {
	svc, _ := newService(t)
	a, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: "k", Title: "A", Body: "a"})
	if err := svc.Retract(ctx, actor, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "state", Key: "k", Title: "B", Body: "b"}); err != nil {
		t.Fatal(err)
	}
	act := "active"
	if err := svc.Patch(ctx, actor, a.ID, NotePatch{Status: &act}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("want bad input, got %v", err)
	}
}
