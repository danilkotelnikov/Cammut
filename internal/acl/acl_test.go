package acl

import "testing"

func TestAllowed(t *testing.T) {
	cases := []struct {
		name   string
		scopes []string
		up     string
		tool   string
		want   bool
	}{
		{"nil scopes deny", nil, "hindsight", "recall", false},
		{"empty scopes deny", []string{}, "hindsight", "recall", false},
		{"star allows all", []string{"*"}, "hindsight", "recall", true},
		{"bare upstream allows its tools", []string{"hindsight"}, "hindsight", "recall", true},
		{"other upstream denied", []string{"hindsight/*"}, "openviking", "find", false},
		{"tool prefix glob", []string{"hindsight/rec*"}, "hindsight", "recall", true},
		{"tool prefix glob miss", []string{"hindsight/rec*"}, "hindsight", "retain", false},
		{"any upstream one tool", []string{"*/find"}, "openviking", "find", true},
		{"any upstream wrong tool", []string{"*/find"}, "openviking", "read", false},
		{"slash inside tool name", []string{"hindsight/*"}, "hindsight", "a/b", true},
		{"no prefix leakage", []string{"hindsight"}, "hindsight2", "recall", false},
		{"overlapping glob needs both parts", []string{"a*a"}, "a", "x", false},
		{"any scope may grant", []string{"nope/x", "hindsight/recall"}, "hindsight", "recall", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Allowed(c.scopes, c.up, c.tool); got != c.want {
				t.Fatalf("Allowed(%v,%q,%q)=%v, want %v", c.scopes, c.up, c.tool, got, c.want)
			}
		})
	}
}

func TestUpstreamVisible(t *testing.T) {
	if UpstreamVisible(nil, "alpha") {
		t.Fatal("empty scopes must see nothing")
	}
	if !UpstreamVisible([]string{"alpha/echo"}, "alpha") {
		t.Fatal("a scoped upstream must be visible")
	}
	if UpstreamVisible([]string{"alpha/echo"}, "beta") {
		t.Fatal("an unscoped upstream must be hidden")
	}
	if !UpstreamVisible([]string{"*"}, "beta") {
		t.Fatal("wildcard sees everything")
	}
}
