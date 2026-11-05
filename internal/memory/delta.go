package memory

// Op is one change between two versions of a brief's inline lines.
type Op struct {
	Op   string `json:"op"` // add | update | remove
	Ref  string `json:"ref"`
	Line string `json:"line"`
}

// Delta lists what a reader holding prev must apply to reach next: adds and updates in next's order, then removals
// in prev's order (a removal carries no line; the reader already has it).
func Delta(prev, next []Item) []Op {
	old := make(map[string]string, len(prev))
	for _, it := range prev {
		old[it.Ref] = it.Line
	}
	now := make(map[string]bool, len(next))
	var ops []Op
	for _, it := range next {
		now[it.Ref] = true
		switch line, ok := old[it.Ref]; {
		case !ok:
			ops = append(ops, Op{"add", it.Ref, it.Line})
		case line != it.Line:
			ops = append(ops, Op{"update", it.Ref, it.Line})
		}
	}
	for _, it := range prev {
		if !now[it.Ref] {
			ops = append(ops, Op{"remove", it.Ref, ""})
		}
	}
	return ops
}
