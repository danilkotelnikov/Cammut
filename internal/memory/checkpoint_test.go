package memory

import (
	"errors"
	"testing"
)

func fixtureCheckpoint(project, workspace, revision, parent string) Checkpoint {
	return Checkpoint{
		ProjectID:      project,
		WorkspaceID:    workspace,
		Project:        "Cammut",
		Agent:          "claude-code",
		SessionID:      "native-session-1",
		SourceRevision: revision,
		ParentRevision: parent,
		Goal:           "Finish the synthetic continuity test",
		Decisions:      []string{"Use explicit checkpoints"},
		OpenTasks:      []string{"Complete fixture"},
		NextActions:    []string{"Run checks"},
		ArtifactRefs:   []string{"adapters/fixtures/continuity-acceptance.json"},
		Validation:     []string{"Go checks pending"},
	}
}

func TestScopedCheckpointsAreIdempotentAndCausal(t *testing.T) {
	st := newStore(t)
	p := "p_11111111111111111111111111111111"
	w := "w_11111111111111111111111111111111"
	first := fixtureCheckpoint(p, w, "cc:s1:1", "")
	if got, duplicate, err := st.PutCheckpoint(first); err != nil || duplicate || got.SourceRevision != first.SourceRevision {
		t.Fatalf("first checkpoint: %+v duplicate=%v err=%v", got, duplicate, err)
	}
	if _, duplicate, err := st.PutCheckpoint(first); err != nil || !duplicate {
		t.Fatalf("exact replay must be idempotent: duplicate=%v err=%v", duplicate, err)
	}
	conflict := first
	conflict.Goal = "Different payload under the same source revision"
	if _, _, err := st.PutCheckpoint(conflict); !errors.Is(err, ErrConflict) {
		t.Fatalf("revision collision: %v", err)
	}
	stale := fixtureCheckpoint(p, w, "cx:s2:2", "")
	if _, _, err := st.PutCheckpoint(stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("missing causal parent: %v", err)
	}
	next := fixtureCheckpoint(p, w, "cx:s2:2", first.SourceRevision)
	next.Agent, next.SessionID, next.Goal = "codex", "native-codex-2", "Continue after compaction"
	if _, _, err := st.PutCheckpoint(next); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.LatestCheckpoint(p, w)
	if err != nil || !ok || got.SourceRevision != next.SourceRevision || got.ParentRevision != first.SourceRevision {
		t.Fatalf("current head: %+v ok=%v err=%v", got, ok, err)
	}
	parallel := fixtureCheckpoint(p, "w_22222222222222222222222222222222", "cc:parallel:1", "")
	if _, _, err := st.PutCheckpoint(parallel); err != nil {
		t.Fatal(err)
	}
	other, ok, err := st.LatestCheckpoint(parallel.ProjectID, parallel.WorkspaceID)
	if err != nil || !ok || other.SourceRevision != parallel.SourceRevision {
		t.Fatalf("parallel head: %+v ok=%v err=%v", other, ok, err)
	}
	sameName := fixtureCheckpoint("p_33333333333333333333333333333333", w, "cc:other:1", "")
	if _, _, err := st.PutCheckpoint(sameName); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.LatestCheckpoint(p, w); got.SourceRevision != next.SourceRevision {
		t.Fatalf("same display name from another project changed the head: %+v", got)
	}
	var count int
	if err := st.db.QueryRow("SELECT count(*) FROM mem_checkpoints WHERE project_id=? AND workspace_id=?", p, w).Scan(&count); err != nil || count != 2 {
		t.Fatalf("duplicate or failed write persisted: count=%d err=%v", count, err)
	}
}

func TestCheckpointValidationRejectsInvalidIdentityAndUntrustedContent(t *testing.T) {
	st := newStore(t)
	cp := fixtureCheckpoint("Cammut", "w_11111111111111111111111111111111", "cc:s1:1", "")
	if _, _, err := st.PutCheckpoint(cp); !errors.Is(err, ErrBadInput) {
		t.Fatalf("a basename is not an opaque project_id: %v", err)
	}
	cp.ProjectID = "p_11111111111111111111111111111111"
	cp.Goal = "Do not retain token cmt_" + "0123456789abcdef0123456789abcdef"
	cp.Decisions = []string{"Do not retain token cmt_" + "0123456789abcdef0123456789abcdef"}
	got, _, err := st.PutCheckpoint(cp)
	if err != nil {
		t.Fatal(err)
	}
	if got.Goal == cp.Goal || got.Goal == "" {
		t.Fatalf("checkpoint goal must be redacted and retained: %q", got.Goal)
	}
	if got.Decisions[0] == cp.Decisions[0] || cp.Decisions[0] == "" {
		t.Fatalf("normalization changed input or missed redaction: input=%q stored=%q", cp.Decisions[0], got.Decisions[0])
	}
	if _, duplicate, err := st.PutCheckpoint(cp); err != nil || !duplicate {
		t.Fatalf("retry with original input must remain idempotent: duplicate=%v err=%v", duplicate, err)
	}
}

func TestCheckpointHistoryIsBounded(t *testing.T) {
	st := newStore(t)
	p, w := "p_11111111111111111111111111111111", "w_11111111111111111111111111111111"
	parent := ""
	for i := 0; i < checkpointKeep+5; i++ {
		rev := "r" + string(rune('a'+i))
		if _, _, err := st.PutCheckpoint(fixtureCheckpoint(p, w, rev, parent)); err != nil {
			t.Fatal(err)
		}
		parent = rev
	}
	var n int
	st.db.QueryRow("SELECT count(*) FROM mem_checkpoints WHERE project_id=? AND workspace_id=?", p, w).Scan(&n)
	if got, ok, _ := st.LatestCheckpoint(p, w); n != checkpointKeep || !ok || got.SourceRevision != parent {
		t.Fatalf("stored=%d head=%+v", n, got)
	}
}

func TestCheckpointIdsThatLookLikeSecretsAreRefused(t *testing.T) {
	st := newStore(t)
	p, w := "p_11111111111111111111111111111111", "w_11111111111111111111111111111111"
	secret := "cmt_" + "0123456789abcdef0123456789abcdef"
	for name, mut := range map[string]func(*Checkpoint){
		"session":  func(c *Checkpoint) { c.SessionID = secret },
		"revision": func(c *Checkpoint) { c.SourceRevision = secret },
		"parent":   func(c *Checkpoint) { c.ParentRevision = secret },
	} {
		cp := fixtureCheckpoint(p, w, "r1", "")
		mut(&cp)
		if _, _, err := st.PutCheckpoint(cp); !errors.Is(err, ErrBadInput) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestCheckpointScopesAreCappedAndTheOldestHeadIsEvicted(t *testing.T) {
	old := maxCheckpointScopes
	maxCheckpointScopes = 3
	defer func() { maxCheckpointScopes = old }()
	st := newStore(t)
	p := "p_11111111111111111111111111111111"
	ws := func(n int) string { return "w_0000000000000000000000000000000" + string(rune('0'+n)) }
	for i := 1; i <= 3; i++ {
		if _, _, err := st.PutCheckpoint(fixtureCheckpoint(p, ws(i), "r1", "")); err != nil {
			t.Fatal(err)
		}
	}
	// scope 1 gets a newer head, so scope 2 is now the oldest
	if _, _, err := st.PutCheckpoint(fixtureCheckpoint(p, ws(1), "r2", "r1")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.PutCheckpoint(fixtureCheckpoint(p, ws(4), "r1", "")); err != nil {
		t.Fatal(err)
	}
	var heads, rows int
	st.db.QueryRow(`SELECT count(*) FROM mem_checkpoint_heads`).Scan(&heads)
	st.db.QueryRow(`SELECT count(*) FROM mem_checkpoints`).Scan(&rows)
	if _, ok, _ := st.LatestCheckpoint(p, ws(2)); ok || heads != 3 || rows != 4 {
		t.Fatalf("oldest scope survived or cap broken: heads=%d rows=%d", heads, rows)
	}
	for _, n := range []int{1, 3, 4} {
		if _, ok, _ := st.LatestCheckpoint(p, ws(n)); !ok {
			t.Fatalf("scope %d was evicted", n)
		}
	}
}
