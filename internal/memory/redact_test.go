package memory

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestRedactAgreesWithTheSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../adapters/redact-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			In             string   `json:"in"`
			MustNotContain []string `json:"mustNotContain"`
			MustContain    string   `json:"mustContain"`
		} `json:"cases"`
		Prose []string `json:"prose"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 20 || len(fx.Prose) < 3 {
		t.Fatalf("fixture too small: %d/%d", len(fx.Cases), len(fx.Prose))
	}
	for _, c := range fx.Cases {
		out := Redact(c.In)
		if !strings.Contains(out, c.MustContain) {
			t.Errorf("not redacted: %q -> %q", c.In, out)
		}
		for _, bad := range c.MustNotContain {
			if strings.Contains(out, bad) {
				t.Errorf("secret survived: %q in %q", bad, out)
			}
		}
	}
	for _, p := range fx.Prose {
		if Redact(p) != p {
			t.Errorf("prose damaged: %q -> %q", p, Redact(p))
		}
	}
	t.Logf("cases=%d prose=%d", len(fx.Cases), len(fx.Prose))
}

func TestRedactTreatsUnicodeWhitespaceLikeJavaScript(t *testing.T) {
	// JS \s includes NBSP and \v, Go's does not: the value must stop at the space in both.
	if got := Redact("password: hunter2hunter2 and then more words"); strings.Contains(got, "hunter2") || !strings.Contains(got, "and then more words") {
		t.Fatalf("%q", got)
	}
}

func TestStoredNotesAreRedactedAndTheSecretIsNotFindable(t *testing.T) {
	s := newStore(t)
	a, err := s.AddNote(Note{Project: "p", Kind: "decision", Title: "Use token cmt_" + strings.Repeat("ab", 20), Body: "password: hunter2hunter2 was used", Tags: []string{"sk-Ab3dE5gH7jK9mN1pQ3rS5tU7"}, SourceAgent: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(a.Title, "cmt_ab") || strings.Contains(a.Body, "hunter2") || !strings.Contains(a.Body, "[REDACTED") || strings.Contains(a.Tags[0], "Ab3dE5") {
		t.Fatalf("stored unredacted: %+v", a)
	}
	got, _, _ := s.GetNote(a.ID)
	if strings.Contains(got.Title+got.Body+got.Tags[0], "hunter2") {
		t.Fatalf("the stored row carries the secret: %+v", got)
	}
	if hits, _ := s.SearchFTS("p", "hunter2hunter2", nil, 5); len(hits) != 0 {
		t.Fatal("a secret must not be findable")
	}
	body := "now it is clean"
	if err := s.UpdateNote(a.ID, NotePatch{Body: &body, Title: ptr("token cmt_" + strings.Repeat("cd", 20))}); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := s.GetNote(a.ID); strings.Contains(got.Title, "cmt_cd") {
		t.Fatalf("an update must redact too: %+v", got)
	}
}

func ptr[T any](v T) *T { return &v }
