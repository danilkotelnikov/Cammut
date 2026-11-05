package memory

import (
	"errors"
	"strings"
	"testing"
)

var human = Actor{Agent: "user:alice", Human: true, CanObserve: true, NoDelivery: true}

func TestEpistemicDefaultsAgentsInferredPeopleObserved(t *testing.T) {
	svc, _ := newService(t)
	a, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "agent wrote", Body: "x"})
	if err != nil || a.Epistemic != Inferred {
		t.Fatalf("agent default: %+v %v", a, err)
	}
	h, err := svc.Remember(ctx, human, Note{Project: "p", Kind: "finding", Title: "person wrote", Body: "y"})
	if err != nil || h.Epistemic != Observed {
		t.Fatalf("person default: %+v %v", h, err)
	}
	if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "claims to have seen it", Body: "z", Epistemic: Observed}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("an agent cannot self-declare observed: %v", err)
	}
	if _, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "t", Body: "z", Epistemic: "certain"}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("unknown value: %v", err)
	}
}

func TestSpeculativeNotesStayOutOfTheBriefAndRecallUnlessAsked(t *testing.T) {
	svc, _ := newService(t)
	remember(t, svc, "decision", "Use FTS5", "it is in the driver")
	sp, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "Hire three engineers", Body: "a budget guess for hiring engineers", Epistemic: Speculative})
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range []string{"core", "full"} {
		b, err := svc.Brief(ctx, actor, "p", BriefRequest{Tier: tier})
		if err != nil || strings.Contains(b.Body, "Hire three") {
			t.Fatalf("%s brief shows a speculative note: %q %v", tier, b.Body, err)
		}
		if b.Accounting.Active != 1 {
			t.Fatalf("accounting counts what the brief can show: %+v", b.Accounting)
		}
	}
	if hits, _ := svc.Recall(ctx, actor, RecallQuery{Project: "p", Query: "hiring engineers budget"}); len(hits) != 0 {
		t.Fatalf("recall leaks a speculative note: %+v", hits)
	}
	hits, err := svc.Recall(ctx, actor, RecallQuery{Project: "p", Query: "hiring engineers budget", IncludeSpeculative: true})
	if err != nil || len(hits) != 1 || hits[0].ID != sp.ID {
		t.Fatalf("explicit request: %+v %v", hits, err)
	}
	if Forwardable(sp) {
		t.Fatal("a speculative note is never forwarded to Hindsight")
	}
}

func TestConfirmUpgradesAndOnlyAPersonOrAScopedTokenMakesItObserved(t *testing.T) {
	svc, _ := newService(t)
	sp, _ := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "Headcount guess", Body: "maybe five people", Epistemic: Speculative})
	if _, err := svc.ConfirmNote(ctx, actor, sp.ID, Observed); !errors.Is(err, ErrBadInput) {
		t.Fatalf("an agent cannot confirm to observed: %v", err)
	}
	n, err := svc.ConfirmNote(ctx, actor, sp.ID, Inferred)
	if err != nil || n.Epistemic != Inferred {
		t.Fatalf("upgrade to inferred: %+v %v", n, err)
	}
	if b, _ := svc.Brief(ctx, actor, "p", BriefRequest{}); !strings.Contains(b.Body, "Headcount guess") {
		t.Fatalf("an inferred note joins the brief: %q", b.Body)
	}
	if _, err := svc.ConfirmNote(ctx, actor, sp.ID, Speculative); !errors.Is(err, ErrBadInput) {
		t.Fatalf("confirm never downgrades: %v", err)
	}
	n, err = svc.ConfirmNote(ctx, human, sp.ID, Observed)
	if err != nil || n.Epistemic != Observed {
		t.Fatalf("person confirms: %+v %v", n, err)
	}
	if _, err := svc.ConfirmNote(ctx, human, "NOPE", Observed); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown note: %v", err)
	}
}

func TestRedactionRunsBeforeAnySpeculativeNoteIsStored(t *testing.T) {
	svc, _ := newService(t)
	sp, err := svc.Remember(ctx, actor, Note{Project: "p", Kind: "finding", Title: "guess about a key", Body: "maybe the key is sk-abcdefghijklmnopqrstuvwxyz0123", Epistemic: Speculative})
	if err != nil {
		t.Fatal(err)
	}
	n, _, _ := svc.st.GetNote(sp.ID)
	if strings.Contains(n.Body, "sk-abcdefgh") || !strings.Contains(n.Body, "[REDACTED") {
		t.Fatalf("stored body: %q", n.Body)
	}
}
