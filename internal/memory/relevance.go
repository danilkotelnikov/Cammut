package memory

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// stopwords are dropped from queries before they reach full-text search: a question such as "how do I run the tests"
// must not match every note that contains "the". English and Russian, function words only.
var stopwords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`a an the and or but if then so as at by for from in into of on onto to up with without about over under
		is are was were be been being am do does did done doing have has had having can could should would will shall may might must
		i me my we us our you your he him his she her it its they them their this that these those there here
		what which who whom whose when where why how whether not no yes any some all each every more most much many such very just also too
		than then now out off again once only own same other another get got give go going let make made need needs take want
		и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему
		теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между`) {
		m[w] = true
	}
	return m
}()

// contentTerms lowercases text and returns its words (letters and digits) of two or more characters with stop words
// dropped, in order of first appearance. Single characters are not words: "I", "a" and stray digits carry no meaning.
func contentTerms(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, f := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if runes(f) < 2 || stopwords[f] || seen[f] {
			continue
		}
		seen[f] = true
		out = append(out, f)
	}
	return out
}

// Gate holds the relevance thresholds of text recall. A note is returned when
//   - at least lexicalNeed(n) of the query's n content words occur in it (as word prefixes), or
//   - its vector's cosine to the query reaches the adaptive threshold tau, or
//   - both arms agree: one word occurs and the cosine reaches tau - AgreeRelax.
//
// tau is Base for a normal query, Short for a very short one (fewer than ShortTerms words or at most ShortChars
// characters) and Long for a long one (LongTerms words or more than LongChars characters). When the best note leads
// the second best by LeadGap, that one note is admitted at tau - LeadRelax. When the best note is a clear match
// (cosine at least DominantCos), notes with no lexical match whose cosine is under DominantFrac of it are not added.
// Nothing drops below MinFloor. Calibrate on real data with the golden set and docs/MEMORY-GATES.md; the defaults
// suit a 384-dimension multilingual sentence model.
type Gate struct {
	Base, Short, Long              float64
	LeadGap, LeadRelax, AgreeRelax float64
	DominantCos, DominantFrac      float64
	MinFloor                       float64
	ShortTerms, ShortChars         int
	LongTerms, LongChars           int
}

// DefaultGate is used when Ranker.Gate is the zero value.
var DefaultGate = Gate{Base: 0.38, Short: 0.48, Long: 0.30, LeadGap: 0.12, LeadRelax: 0.06, AgreeRelax: 0.04,
	DominantCos: 0.6, DominantFrac: 0.6, MinFloor: 0.22, ShortTerms: 3, ShortChars: 12, LongTerms: 7, LongChars: 50}

func (g Gate) orDefault() Gate {
	if g == (Gate{}) {
		return DefaultGate
	}
	return g
}

// lexicalNeed is how many of n content words must occur in a note for a text-only match: all of them for one or two
// words, 2 for three to six, then one more for every four further words.
func (g Gate) lexicalNeed(n int) int {
	if n <= 2 {
		return max(n, 1)
	}
	return 2 + (n-3)/4
}

// threshold is the cosine a vector-only hit must reach for this query, by its length.
func (g Gate) threshold(query string, terms int, _ map[string]float64) float64 {
	switch n := runes(strings.TrimSpace(query)); {
	case terms >= g.LongTerms || n > g.LongChars:
		return max(g.Long, g.MinFloor)
	case terms < g.ShortTerms || n <= g.ShortChars:
		return max(g.Short, g.MinFloor)
	}
	return max(g.Base, g.MinFloor)
}

// leadThreshold lowers tau for the best note when it leads the second best by LeadGap.
func (g Gate) leadThreshold(tau float64, cos map[string]float64) float64 {
	var first, second float64
	for _, c := range cos {
		if c > first {
			first, second = c, first
		} else if c > second {
			second = c
		}
	}
	if first > 0 && first-max(second, g.MinFloor) >= g.LeadGap {
		return max(tau-g.LeadRelax, g.MinFloor)
	}
	return tau
}

// dominated reports whether a note with cosine c is much weaker than a clear winner with cosine best.
func (g Gate) dominated(c, best float64) bool {
	return best >= g.DominantCos && c < g.DominantFrac*best
}

// termsMatched counts the query terms that begin some word of the note's title, body or tags.
func termsMatched(terms []string, n Note) int {
	words := strings.FieldsFunc(strings.ToLower(n.Title+" "+n.Body+" "+strings.Join(n.Tags, " ")), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	count := 0
	for _, t := range terms {
		for _, w := range words {
			if strings.HasPrefix(w, t) {
				count++
				break
			}
		}
	}
	return count
}

// ParseGate reads "base,short,long" (for example "0.38,0.48,0.30") over DefaultGate. short >= base >= long, all in
// [MinFloor, 1): a stricter bar for short queries, a looser one for long ones.
func ParseGate(s string) (Gate, error) {
	g := DefaultGate
	parts := strings.Split(strings.TrimSpace(s), ",")
	if len(parts) != 3 {
		return Gate{}, fmt.Errorf("gate must be base,short,long")
	}
	var v [3]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil || f < g.MinFloor || f >= 1 {
			return Gate{}, fmt.Errorf("gate value %q must be a number in [%.2f, 1)", p, g.MinFloor)
		}
		v[i] = f
	}
	if !(v[1] >= v[0] && v[0] >= v[2]) {
		return Gate{}, fmt.Errorf("gate needs short >= base >= long")
	}
	g.Base, g.Short, g.Long = v[0], v[1], v[2]
	return g, nil
}
