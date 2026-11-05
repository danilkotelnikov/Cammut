package index

import "testing"

var fixture = []Entry{
	{Upstream: "hindsight", Tool: "recall", Description: "Search memories to provide personalized, context-aware responses."},
	{Upstream: "hindsight", Tool: "retain", Description: "Store important information to long-term memory."},
	{Upstream: "openviking", Tool: "find", Description: "Fast semantic retrieval without session context."},
	{Upstream: "notes", Tool: "search_notes", Description: "Поиск заметок и воспоминаний пользователя."},
}

func keys(es []Entry) []string {
	out := make([]string, 0, len(es))
	for _, e := range es {
		out = append(out, e.Key())
	}
	return out
}

func TestSearchRanksNameHitsFirst(t *testing.T) {
	got := New(fixture).Search("recall", 5, nil)
	if len(got) == 0 || got[0].Key() != "hindsight/recall" {
		t.Fatalf("got %v", keys(got))
	}
}

func TestSearchDescriptionTerms(t *testing.T) {
	got := New(fixture).Search("store memory", 5, nil)
	if len(got) != 1 || got[0].Key() != "hindsight/retain" {
		t.Fatalf("got %v", keys(got))
	}
}

func TestSearchAllowFilter(t *testing.T) {
	deny := func(e Entry) bool { return e.Upstream != "hindsight" }
	if got := New(fixture).Search("memory recall retain", 5, deny); len(got) != 0 {
		t.Fatalf("filtered entries leaked: %v", keys(got))
	}
}

func TestSearchLimitAndEmptyQuery(t *testing.T) {
	ix := New(fixture)
	if got := ix.Search("", 2, nil); len(got) != 2 {
		t.Fatalf("empty query should list entries up to the limit, got %v", keys(got))
	}
	if got := ix.Search("", 0, nil); len(got) != len(fixture) {
		t.Fatalf("limit 0 means no cap, got %v", keys(got))
	}
}

func TestSearchUnicode(t *testing.T) {
	got := New(fixture).Search("воспоминаний", 5, nil)
	if len(got) != 1 || got[0].Key() != "notes/search_notes" {
		t.Fatalf("got %v", keys(got))
	}
}

func TestSearchNoMatchIsEmptyNotNil(t *testing.T) {
	got := New(fixture).Search("zzzzqqq", 5, nil)
	if got == nil || len(got) != 0 {
		t.Fatalf("want empty non-nil slice, got %#v", got)
	}
}
