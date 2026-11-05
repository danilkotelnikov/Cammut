package archive

import (
	"encoding/json"
	"os"
	"testing"
)

// The PC computes segment ids in JavaScript. adapters/archive-id-fixtures.json holds metas with the ids the JS
// segmentId produced; the JS test asserts the same file, so the two implementations cannot drift apart.
func TestSegmentIDMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../adapters/archive-id-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx []struct {
		Meta struct {
			Agent   string `json:"agent"`
			Session string `json:"session"`
			Kind    string `json:"kind"`
			Relpath string `json:"relpath"`
			FP      string `json:"fp"`
			Start   int64  `json:"start"`
			End     int64  `json:"end"`
		} `json:"meta"`
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx) < 6 {
		t.Fatalf("expected at least 6 fixtures, got %d", len(fx))
	}
	for i, f := range fx {
		m := Meta{Agent: f.Meta.Agent, SessionID: f.Meta.Session, Kind: f.Meta.Kind, Relpath: f.Meta.Relpath, FP: f.Meta.FP, SrcStart: f.Meta.Start, SrcEnd: f.Meta.End}
		if got := SegmentID(m); got != f.ID {
			t.Fatalf("fixture %d: Go %s, JS %s", i, got, f.ID)
		}
	}
}
