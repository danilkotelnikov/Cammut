package memory

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// Meaning atoms: a deterministic guard that a shortened or rewritten text keeps the words that flip a meaning.
// An atom is a marker (negation, modal, conditional, ordering, quantifier, comparator) with a small window of the
// plain words around it, or a number with its unit. Windows never cross a sentence or clause boundary, and they skip
// other markers and numbers, so dropping an unrelated "at least 3" does not change what "must" is attached to.
// The check is deliberately strict: a rephrasing that moves a marker out of its window is rejected, which only ever
// means "not merged" or "fallback gist", never a lost meaning.

// Atom is one meaning-bearing fragment.
type Atom struct {
	Kind   string // neg, modal, cond, ord, quant, cmp, num
	Marker string // canonical marker; for cmp one of >= <= > < =
	Prev   string // ord only: the plain word before the marker
	Next   []string
	Num    string // cmp and num: the value with its unit, e.g. "3 workers"
}

// Key identifies an atom exactly.
func (a Atom) Key() string {
	switch a.Kind {
	case "cmp":
		return "cmp|" + a.Marker + "|" + a.Num
	case "num":
		return "num||" + a.Num
	}
	return a.Kind + "|" + a.Marker + "|" + a.Prev + "|" + strings.Join(a.Next, " ")
}

// markerKey identifies an atom for "was this marker introduced": a comparator counts by its symbol only (the number
// it carries is checked separately as a missing atom), numbers never count.
func (a Atom) markerKey() string {
	switch a.Kind {
	case "num":
		return ""
	case "cmp":
		return "cmp|" + a.Marker
	}
	return a.Key()
}

func (a Atom) String() string {
	switch a.Kind {
	case "cmp":
		return "comparator " + a.Marker + " " + a.Num
	case "num":
		return "number " + a.Num
	}
	s := a.Kind + " " + a.Marker
	if a.Prev != "" {
		s += " (after " + a.Prev + ")"
	}
	return s + " [" + strings.Join(a.Next, " ") + "]"
}

type markerInfo struct{ kind, canon string }

var (
	markers = map[string]markerInfo{}
	bigrams = map[string]markerInfo{
		"must not": {"neg", "must not"}, "only if": {"cond", "only if"}, "prior to": {"ord", "prior to"},
		"at least": {"cmp", ">="}, "at most": {"cmp", "<="}, "more than": {"cmp", ">"}, "less than": {"cmp", "<"},
		"не менее": {"cmp", ">="}, "не более": {"cmp", "<="},
	}
	stop = map[string]bool{}
)

func init() {
	add := func(kind string, words ...string) {
		for _, w := range words {
			markers[w] = markerInfo{kind, w}
		}
	}
	add("neg", "not", "no", "never", "cannot", "don't", "doesn't", "won't", "shouldn't", "can't", "isn't", "aren't", "mustn't", "didn't",
		"without", "не", "нет", "нельзя", "никогда", "без")
	add("modal", "must", "shall", "should", "may", "might", "required", "optional", "only", "always", "нужно", "должен", "можно", "всегда", "только")
	add("cond", "if", "unless", "when", "until", "otherwise", "else", "если", "пока", "иначе")
	add("ord", "before", "after", "then", "first", "last", "finally", "перед", "после", "сначала", "потом")
	add("quant", "all", "any", "every", "each", "none", "both", "все")
	for w, c := range map[string]string{">=": ">=", "≥": ">=", "минимум": ">=", "<=": "<=", "≤": "<=", "максимум": "<=", ">": ">", "<": "<", "exactly": "=", "=": "="} {
		markers[w] = markerInfo{"cmp", c}
	}
	for _, w := range strings.Fields(`the a an of to is are was were be been it its this that these those and or in on at for with by as from into so than up
		и в на с к по из у о а но это что как для при`) {
		stop[w] = true
	}
}

var (
	tokenRe  = regexp.MustCompile(`>=|<=|≥|≤|>|<|=|[\p{L}\p{N}_]+(?:[.,]\p{N}+)*(?:['’]\p{L}+)?`)
	numberRe = regexp.MustCompile(`^\d+(?:[.,]\d+)*$`)
)

type tok struct {
	text   string
	marker *markerInfo
	number bool
	plain  bool
}

// sentences splits at . ! ? ; 。 and newlines; a '.' inside a number or a file name is not a boundary.
func sentences(text string, clause bool) []string {
	var out []string
	var cur []rune
	r := []rune(text)
	flush := func() {
		if s := strings.TrimSpace(string(cur)); s != "" {
			out = append(out, s)
		}
		cur = cur[:0]
	}
	for i, c := range r {
		switch {
		case c == '!' || c == '?' || c == '。' || c == '\n' || (clause && c == ';'):
			flush()
		case c == '.' && (i+1 == len(r) || unicode.IsSpace(r[i+1])):
			flush()
		default:
			cur = append(cur, c)
		}
	}
	flush()
	return out
}

func tokenize(sentence string) []tok {
	raw := tokenRe.FindAllString(strings.ReplaceAll(strings.ToLower(sentence), "’", "'"), -1)
	var out []tok
	for i := 0; i < len(raw); i++ {
		if i+1 < len(raw) {
			if m, ok := bigrams[raw[i]+" "+raw[i+1]]; ok {
				mm := m
				out = append(out, tok{text: m.canon, marker: &mm})
				i++
				continue
			}
		}
		w := raw[i]
		if m, ok := markers[w]; ok {
			mm := m
			out = append(out, tok{text: w, marker: &mm})
		} else if numberRe.MatchString(w) {
			out = append(out, tok{text: w, number: true})
		} else {
			out = append(out, tok{text: w, plain: !stop[w]})
		}
	}
	return out
}

func nextPlain(t []tok, from, n int) []string {
	var out []string
	for i := from; i < len(t) && len(out) < n; i++ {
		if t[i].plain {
			out = append(out, t[i].text)
		}
	}
	return out
}

func prevPlain(t []tok, from int) string {
	for i := from; i >= 0; i-- {
		if t[i].plain {
			return t[i].text
		}
	}
	return ""
}

func unitAfter(t []tok, i int) string {
	if i+1 < len(t) && t[i+1].plain {
		return t[i+1].text
	}
	return ""
}

func joinWords(a, b string) string { return strings.TrimSpace(a + " " + b) }

// Atoms extracts the meaning atoms of text (sorted by key, duplicates removed).
func Atoms(text string) []Atom {
	seen := map[string]Atom{}
	for _, s := range sentences(text, true) {
		t := tokenize(s)
		for i, k := range t {
			switch {
			case k.number:
				a := Atom{Kind: "num", Num: joinWords(k.text, unitAfter(t, i))}
				seen[a.Key()] = a
			case k.marker != nil && k.marker.kind == "cmp":
				a := Atom{Kind: "cmp", Marker: k.marker.canon}
				if i+1 < len(t) && t[i+1].number {
					a.Num = joinWords(t[i+1].text, unitAfter(t, i+1))
				} else if p := nextPlain(t, i+1, 1); len(p) == 1 {
					a.Num = p[0]
				}
				seen[a.Key()] = a
			case k.marker != nil:
				a := Atom{Kind: k.marker.kind, Marker: k.marker.canon, Next: nextPlain(t, i+1, 3)}
				if a.Kind == "ord" {
					a.Prev = prevPlain(t, i-1)
				}
				seen[a.Key()] = a
			}
		}
	}
	out := make([]Atom, 0, len(seen))
	for _, a := range seen {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key() < out[j].Key() })
	return out
}

// MeaningResult is the difference between sources and an output text.
type MeaningResult struct {
	Missing []Atom // atoms of the sources the output lacks: a dropped negation, a softened modal, a lost number
	Added   []Atom // marker atoms of the output that no source has: an introduced negation, modal, comparator or ordering
}

// MeaningDiff compares the atoms of the sources with those of out.
func MeaningDiff(src []string, out string) MeaningResult {
	outAtoms := Atoms(out)
	have := map[string]bool{}
	for _, a := range outAtoms {
		have[a.Key()] = true
	}
	srcKeys, srcMarkers := map[string]bool{}, map[string]bool{}
	var res MeaningResult
	for _, s := range src {
		for _, a := range Atoms(s) {
			if srcKeys[a.Key()] {
				continue
			}
			srcKeys[a.Key()] = true
			srcMarkers[a.markerKey()] = true
			if !have[a.Key()] {
				res.Missing = append(res.Missing, a)
			}
		}
	}
	for _, a := range outAtoms {
		if mk := a.markerKey(); mk != "" && !srcMarkers[mk] {
			res.Added = append(res.Added, a)
		}
	}
	return res
}

func contentWords(sentence string) map[string]bool {
	out := map[string]bool{}
	for _, k := range tokenize(sentence) {
		if k.plain || k.number {
			out[k.text] = true
		}
	}
	return out
}

// ValidateGist returns what makes a gist unsafe: marker atoms it introduces, plus the negation, modal, comparator and
// number atoms of every body sentence it overlaps (shares three content words with) that it lacks. A gist may leave
// whole clauses out; it may not keep a clause and drop the "never" or the "at least 3" that belongs to it.
func ValidateGist(body, gist string) []Atom {
	gistAtoms := Atoms(gist)
	have := map[string]bool{}
	for _, a := range gistAtoms {
		have[a.Key()] = true
	}
	bodyKeys := map[string]bool{}
	for _, a := range Atoms(body) {
		bodyKeys[a.Key()] = true
	}
	var bad []Atom
	flagged := map[string]bool{}
	flag := func(a Atom) {
		if !flagged[a.Key()] {
			flagged[a.Key()] = true
			bad = append(bad, a)
		}
	}
	for _, a := range gistAtoms {
		if !bodyKeys[a.Key()] {
			flag(a) // introduced or changed: a marker or number the body does not have in this form
		}
	}
	gw := contentWords(gist)
	for _, s := range sentences(body, true) {
		shared := 0
		for w := range contentWords(s) {
			if gw[w] {
				shared++
			}
		}
		if shared < 3 {
			continue
		}
		for _, a := range Atoms(s) {
			switch a.Kind {
			case "neg", "modal", "cmp", "num":
				if !have[a.Key()] {
					flag(a)
				}
			}
		}
	}
	sort.Slice(bad, func(i, j int) bool { return bad[i].Key() < bad[j].Key() })
	return bad
}
