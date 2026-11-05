package memory

import (
	"context"
	"testing"
)

func TestGateIsTighterForShortQueriesAndLooserForLongOnes(t *testing.T) {
	g := DefaultGate
	short := g.threshold("deploy staging", 2, nil)
	normal := g.threshold("how do I deploy to the staging server", 4, nil)
	long := g.threshold("how do I deploy the release candidate to the staging cluster and then promote it to production", 9, nil)
	if !(short > normal && normal > long) {
		t.Fatalf("want short > normal > long, got %.2f %.2f %.2f", short, normal, long)
	}
	if long < g.MinFloor {
		t.Fatalf("never below the floor: %.2f", long)
	}
}

func TestACleanWinnerIsAdmittedAtALowerBarThanARunnerUp(t *testing.T) {
	g := DefaultGate
	tau := g.threshold("deploy staging please now", 4, nil)
	if got := g.leadThreshold(tau, map[string]float64{"a": 0.60, "b": 0.30}); got >= tau {
		t.Fatalf("a clear leader earns a lower bar: %.2f vs %.2f", got, tau)
	}
	if got := g.leadThreshold(tau, map[string]float64{"a": 0.60, "b": 0.55}); got != tau {
		t.Fatalf("no clear leader, no relaxation: %.2f vs %.2f", got, tau)
	}
}

func TestLexicalNeedGrowsWithTheLengthOfTheQuery(t *testing.T) {
	g := DefaultGate
	for n, want := range map[int]int{1: 1, 2: 2, 3: 2, 6: 2, 7: 3, 10: 3, 11: 4} {
		if got := g.lexicalNeed(n); got != want {
			t.Errorf("lexicalNeed(%d) = %d, want %d", n, got, want)
		}
	}
}

func TestOneSharedWordInALongerQueryIsNotAMatchAndIsReportedAsAbstention(t *testing.T) {
	s := newStore(t)
	s.UpsertProject("p", "")
	if _, err := s.AddNote(Note{Project: "p", Kind: "howto", Title: "Run the gate", Body: "bash dev/gate.sh runs the Go tests", SourceAgent: "t"}); err != nil {
		t.Fatal(err)
	}
	r := &Ranker{st: s}
	cases := []struct {
		q    string
		want bool // hits expected
	}{
		{"gate", true},
		{"go tests", true},
		{"which gate do birds use when migrating south for winter", false},
		{"the", false},
		{"how do I", false},
	}
	for _, c := range cases {
		res, err := r.Recall(context.Background(), RecallQuery{Project: "p", Query: c.q})
		if err != nil {
			t.Fatal(err)
		}
		if (len(res.Hits) > 0) != c.want || (len(res.Hits) == 0 && res.Abstained != Abstained) || (len(res.Hits) > 0 && res.Abstained != "") {
			t.Errorf("%q: hits=%d abstained=%q, want hits=%v", c.q, len(res.Hits), res.Abstained, c.want)
		}
	}
}

func TestStopWordsAreEnglishAndRussian(t *testing.T) {
	got := contentTerms("How do I run the tests и как запустить тесты")
	want := []string{"run", "tests", "запустить", "тесты"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v", got)
		}
	}
}

func TestParseGateOverridesTheThreeCosineThresholds(t *testing.T) {
	g, err := ParseGate("0.40,0.50,0.32")
	if err != nil || g.Base != 0.40 || g.Short != 0.50 || g.Long != 0.32 || g.AgreeRelax != DefaultGate.AgreeRelax {
		t.Fatalf("%+v %v", g, err)
	}
	for _, bad := range []string{"", "0.4", "0.4,0.5", "a,b,c", "0.3,0.4,0.5", "1.2,1.3,1.1", "0.4,0.5,0.1"} {
		if _, err := ParseGate(bad); err == nil {
			t.Errorf("%q must be refused (need base,short,long with short >= base >= long, all in [0.22, 1))", bad)
		}
	}
}
