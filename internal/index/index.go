// Package index is a tiny keyword search over upstream tool descriptions.
package index

import (
	"encoding/json"
	"sort"
	"strings"
	"unicode"
)

// Entry describes one upstream tool.
type Entry struct {
	Upstream    string          `json:"upstream"`
	Tool        string          `json:"tool"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema,omitempty"`
}

// Key is the address agents use: "upstream/tool".
func (e Entry) Key() string { return e.Upstream + "/" + e.Tool }

type Index struct{ entries []Entry }

func New(entries []Entry) *Index {
	cp := append([]Entry(nil), entries...)
	sort.Slice(cp, func(i, j int) bool { return cp[i].Key() < cp[j].Key() })
	return &Index{entries: cp}
}

// Search ranks entries by weighted term hits (name x3, description x1; prefix hits count half).
// An empty query lists everything the filter allows. limit <= 0 means no cap. The result is never nil.
// ponytail: plain term weighting; move to BM25 if the catalog grows past about 1000 tools.
func (ix *Index) Search(query string, limit int, allow func(Entry) bool) []Entry {
	terms := tokenize(query)
	type scored struct {
		e Entry
		s float64
	}
	var found []scored
	for _, e := range ix.entries {
		if allow != nil && !allow(e) {
			continue
		}
		s := 0.0
		if len(terms) == 0 {
			s = 0.001
		}
		name, desc := tokenize(e.Upstream+" "+e.Tool), tokenize(e.Description)
		for _, t := range terms {
			s += 3*weight(name, t) + weight(desc, t)
		}
		if s > 0 {
			found = append(found, scored{e, s})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].s > found[j].s })
	if limit <= 0 || limit > len(found) {
		limit = len(found)
	}
	out := make([]Entry, 0, limit)
	for _, f := range found[:limit] {
		out = append(out, f.e)
	}
	return out
}

func weight(words []string, t string) float64 {
	n := 0.0
	for _, w := range words {
		switch {
		case w == t:
			n++
		case len(t) >= 3 && strings.HasPrefix(w, t):
			n += 0.5
		}
	}
	return n
}

func tokenize(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}
