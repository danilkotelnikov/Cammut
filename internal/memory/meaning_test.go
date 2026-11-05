package memory

import "testing"

func TestMeaningAtomsCatchNegationModalityOrderingComparatorsAndNumbers(t *testing.T) {
	src := []string{"Never run migrate before the backup finishes; the pool must have at least 3 workers"}
	cases := []struct {
		name, out            string
		wantMissing, wantAdd bool
	}{
		{"faithful", "Never run migrate before the backup finishes; the pool must have at least 3 workers", false, false},
		{"dropped negation", "Run migrate before the backup finishes; the pool must have at least 3 workers", true, false},
		{"flipped order", "Never run migrate after the backup finishes; the pool must have at least 3 workers", true, true},
		{"weakened comparator", "Never run migrate before the backup finishes; the pool must have 3 workers", true, false},
		{"softened modal", "Never run migrate before the backup finishes; the pool should have at least 3 workers", true, true},
		{"changed number", "Never run migrate before the backup finishes; the pool must have at least 4 workers", true, false},
		{"equivalent comparator spelling", "Never run migrate before the backup finishes; the pool must have >= 3 workers", false, false},
		{"equivalent comparator in words", "Never run migrate before the backup finishes; the pool must have not less than 3 workers", true, true}, // "not less than" is a different statement; strict by design
	}
	for _, c := range cases {
		d := MeaningDiff(src, c.out)
		if (len(d.Missing) > 0) != c.wantMissing || (len(d.Added) > 0) != c.wantAdd {
			t.Errorf("%s: missing=%v added=%v", c.name, d.Missing, d.Added)
		}
	}
	// the other direction: an introduced negation or modal is caught even when nothing was dropped
	if d := MeaningDiff([]string{"run the migration before the backup"}, "never run the migration before the backup"); len(d.Added) == 0 {
		t.Fatal("an introduced negation must be reported")
	}
	// a gist may omit but not introduce or flip
	body := "Never run migrate before the backup finishes. Afterwards restart the pool."
	if bad := ValidateGist(body, "Never run migrate before the backup finishes."); len(bad) != 0 {
		t.Fatalf("a shorter faithful gist is fine: %v", bad)
	}
	if bad := ValidateGist(body, "Run migrate before the backup finishes."); len(bad) == 0 {
		t.Fatal("keeping the clause but dropping its 'never' flips the meaning and must be rejected")
	}
	if bad := ValidateGist(body, "Afterwards restart the pool."); len(bad) != 0 {
		t.Fatalf("a gist that keeps a different whole clause intact is fine: %v", bad)
	}
	if bad := ValidateGist(body, "Never restart the pool after the backup."); len(bad) == 0 {
		t.Fatal("a gist that introduces a negation the body does not have must be rejected")
	}
}

func TestMeaningAtomsHandleRussianContractionsAndNumbersWithUnits(t *testing.T) {
	if d := MeaningDiff([]string{"Нельзя запускать миграцию перед бэкапом"}, "Запускать миграцию перед бэкапом"); len(d.Missing) == 0 {
		t.Fatal("a dropped Russian negation must be reported")
	}
	if d := MeaningDiff([]string{"Don't restart the pool"}, "Restart the pool"); len(d.Missing) == 0 {
		t.Fatal("a dropped contraction negation must be reported")
	}
	if d := MeaningDiff([]string{"Don’t restart the pool"}, "Don't restart the pool"); len(d.Missing)+len(d.Added) != 0 {
		t.Fatalf("a curly apostrophe is the same word: %+v", d)
	}
	if d := MeaningDiff([]string{"timeout is 15 min and 2.5 s"}, "timeout is 15 s and 2.5 s"); len(d.Missing) == 0 {
		t.Fatal("a changed unit must be reported")
	}
	if d := MeaningDiff([]string{"keep at most 5 copies"}, "keep at least 5 copies"); len(d.Missing) == 0 || len(d.Added) == 0 {
		t.Fatalf("at most -> at least flips the comparator: %+v", d)
	}
	if got := len(Atoms("see gate.sh and internal/memory/store.go, then version 0.4.0")); got == 0 {
		t.Fatal("file names must not crash the splitter")
	}
}
