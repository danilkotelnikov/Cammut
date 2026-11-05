package memoryapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"cammut/internal/gateway"
	"cammut/internal/memory"
	"cammut/internal/ratelimit"
	"cammut/internal/store"
	"cammut/internal/upstream"
)

type env struct {
	t   *testing.T
	srv *httptest.Server
	st  *store.Store
	n   int
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "g.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ms := memory.NewStore(st.DB(), nil)
	svc := memory.NewService(ms, &memory.Ranker{}, func(a store.Audit) { st.AddAudit(a) }, nil)
	h := gateway.Handler(gateway.Deps{Store: st, Mgr: upstream.NewManager(func(string) string { return "" }), Limiter: ratelimit.New(1000, 1000), Memory: New(svc, nil)})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &env{t: t, srv: srv, st: st}
}

func (e *env) token(scopes ...string) string {
	e.n++
	plain, _, err := e.st.CreateToken(fmt.Sprintf("t%d", e.n), scopes)
	if err != nil {
		e.t.Fatal(err)
	}
	return plain
}

func (e *env) do(tok, method, path string, body any) (*http.Response, []byte) {
	e.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, e.srv.URL+path, rdr)
	r.Header.Set("Authorization", "Bearer "+tok)
	r.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func (e *env) json(tok, method, path string, body any, want int) map[string]any {
	e.t.Helper()
	resp, raw := e.do(tok, method, path, body)
	if resp.StatusCode != want {
		e.t.Fatalf("%s %s: %d (want %d): %s", method, path, resp.StatusCode, want, raw)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

func TestScopesGateEveryOperation(t *testing.T) {
	e := newEnv(t)
	reader := e.token("memory/brief", "memory/recall")
	writer := e.token("memory/*")
	other := e.token("hindsight/*")
	note := map[string]any{"project": "Cammut", "kind": "decision", "title": "Use FTS5", "body": "because it is in the driver", "tags": []string{"sqlite"}}
	if resp, _ := e.do(reader, "POST", "/v1/memory/notes", note); resp.StatusCode != 403 {
		t.Fatalf("reader must not write: %d", resp.StatusCode)
	}
	if resp, _ := e.do(other, "GET", "/v1/memory/brief?project=Cammut", nil); resp.StatusCode != 403 {
		t.Fatalf("foreign scope: %d", resp.StatusCode)
	}
	if resp, _ := e.do("cmt_nottoken", "GET", "/v1/memory/brief?project=Cammut", nil); resp.StatusCode != 401 {
		t.Fatalf("no such token: %d", resp.StatusCode)
	}
	resp, raw := e.do(writer, "POST", "/v1/memory/notes", note)
	if resp.StatusCode != 201 || !strings.Contains(string(raw), `"id"`) {
		t.Fatalf("create: %d %s", resp.StatusCode, raw)
	}
	resp, raw = e.do(reader, "GET", "/v1/memory/brief?project=Cammut", nil)
	var brief map[string]any
	json.Unmarshal(raw, &brief)
	if resp.StatusCode != 200 || brief["generator"] != "template" || !strings.Contains(brief["body"].(string), "Use FTS5") || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("brief: %d %s", resp.StatusCode, raw)
	}
	if resp, _ := e.do(reader, "GET", "/v1/memory/brief?project=Nope", nil); resp.StatusCode != 404 {
		t.Fatalf("unknown project: %d", resp.StatusCode)
	}
	resp, raw = e.do(reader, "POST", "/v1/memory/recall", map[string]any{"query": "fts5 driver", "project": "Cammut"})
	if resp.StatusCode != 200 || !strings.Contains(string(raw), "Use FTS5") {
		t.Fatalf("recall: %d %s", resp.StatusCode, raw)
	}
	for _, bad := range []map[string]any{
		{"project": "Cammut", "kind": "gossip", "title": "x", "body": "y"},
		{"project": "Cammut", "kind": "decision", "title": "x", "body": "y", "surprise": 1},
		{"project": "../etc", "kind": "decision", "title": "x", "body": "y"},
	} {
		if resp, _ := e.do(writer, "POST", "/v1/memory/notes", bad); resp.StatusCode != 400 {
			t.Fatalf("%v: %d", bad, resp.StatusCode)
		}
	}
	resp, raw = e.do(writer, "POST", "/v1/memory/handoff", map[string]any{"project": "Cammut", "agent": "warp", "summary": "stopped after task 2.5", "open_tasks": []string{"2.6", "2.7"}})
	if resp.StatusCode != 201 {
		t.Fatalf("handoff: %d %s", resp.StatusCode, raw)
	}
	_, raw = e.do(reader, "GET", "/v1/memory/brief?project=Cammut", nil)
	if !strings.Contains(string(raw), "Handoff from warp") || !strings.Contains(string(raw), "2.6") {
		t.Fatalf("the brief must show the handoff at once: %s", raw)
	}
	rows, _ := e.st.QueryAudit(store.AuditFilter{Upstream: "memory"})
	tools := map[string]bool{}
	for _, r := range rows {
		tools[r.Tool] = true
	}
	for _, want := range []string{"remember", "brief", "recall", "handoff"} {
		if !tools[want] {
			t.Fatalf("audit lacks %s: %v", want, tools)
		}
	}
	big := strings.Repeat("a", 70<<10)
	if resp, _ := e.do(writer, "POST", "/v1/memory/notes", map[string]any{"project": "Cammut", "kind": "finding", "title": "x", "body": big}); resp.StatusCode != 413 && resp.StatusCode != 400 {
		t.Fatalf("oversized body: %d", resp.StatusCode)
	}
}

func TestANarrowBriefTokenCannotWriteOrRecall(t *testing.T) {
	e := newEnv(t)
	writer := e.token("memory/remember", "memory/brief")
	briefOnly := e.token("memory/brief")
	e.json(writer, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "t", "body": "b"}, 201)
	for _, c := range []struct{ method, path string }{{"POST", "/v1/memory/notes"}, {"POST", "/v1/memory/handoff"}, {"POST", "/v1/memory/recall"}, {"GET", "/v1/memory/notes?project=P"}} {
		if resp, _ := e.do(briefOnly, c.method, c.path, map[string]any{"project": "P", "query": "t", "kind": "state", "title": "x", "body": "y", "summary": "s"}); resp.StatusCode != 403 {
			t.Fatalf("%s %s: %d", c.method, c.path, resp.StatusCode)
		}
	}
	for _, p := range []string{"/v1/memory/brief?project=P", "/v1/memory/projects", "/v1/memory/status"} {
		if resp, raw := e.do(briefOnly, "GET", p, nil); resp.StatusCode != 200 {
			t.Fatalf("%s: %d %s", p, resp.StatusCode, raw)
		}
	}
	if resp, _ := e.do(writer, "POST", "/v1/memory/recall", map[string]any{"query": "t", "project": "P"}); resp.StatusCode != 403 {
		t.Fatalf("remember+brief is not recall: %d", resp.StatusCode)
	}
}

func TestBriefDeltaSectionPagesAndDeliveryOverHTTP(t *testing.T) {
	e := newEnv(t)
	tok := e.token("memory/*")
	for i := 0; i < 150; i++ {
		e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "codemap", "title": fmt.Sprintf("file %03d", i), "body": "what it does"}, 201)
	}
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "task", "title": "ship", "body": "the task"}, 201)
	b := e.json(tok, "GET", "/v1/memory/brief?project=P&session=s1", nil, 200)
	acc := b["accounting"].(map[string]any)
	if b["version"].(float64) != 1 || acc["active"].(float64) != 151 || acc["paged"].(float64) != 90 || !strings.Contains(b["body"].(string), "p-key-files-1") {
		t.Fatalf("%v", b)
	}
	if !strings.HasPrefix(b["delivered"].(string), "delivered: core;") {
		t.Fatalf("delivered line: %v", b["delivered"])
	}
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "decision", "title": "new decision", "body": "later"}, 201)
	d := e.json(tok, "GET", "/v1/memory/brief?project=P&since_version=1&session=s1", nil, 200)
	ops, _ := d["ops"].([]any)
	if d["delta"] != true || d["version"].(float64) != 2 || len(ops) != 1 || ops[0].(map[string]any)["op"] != "add" || d["body"] != nil {
		t.Fatalf("delta: %v", d)
	}
	same := e.json(tok, "GET", "/v1/memory/brief?project=P&since_version=2&session=s1", nil, 200)
	if same["delta"] != true || same["ops"] == nil || len(same["ops"].([]any)) != 0 {
		t.Fatalf("an up-to-date reader gets an empty ops list, not a missing one: %v", same)
	}
	sec := e.json(tok, "GET", "/v1/memory/brief?project=P&section=open+tasks", nil, 200)
	if !strings.Contains(sec["body"].(string), "ship") || strings.Contains(sec["body"].(string), "file 001") {
		t.Fatalf("section: %v", sec["body"])
	}
	r, raw := e.do(tok, "GET", "/v1/memory/brief?project=P&tier=full&format=md", nil)
	if r.StatusCode != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/markdown") || !strings.HasPrefix(string(raw), "# P — brief") || !strings.Contains(string(raw), "file 149") {
		t.Fatalf("md: %d %s %.80s", r.StatusCode, r.Header.Get("Content-Type"), raw)
	}
	pg := e.json(tok, "GET", "/v1/memory/brief?project=P&page=p-key-files-2&session=s1", nil, 200)
	if strings.Count(pg["body"].(string), "\n- **") != 40 {
		t.Fatalf("page: %v", pg["body"])
	}
	e.json(tok, "GET", "/v1/memory/brief?project=P&page=p-nope-1", nil, 404)
	e.json(tok, "GET", "/v1/memory/brief?project=P&tier=huge", nil, 400)
	e.json(tok, "GET", "/v1/memory/brief?project=P&since_version=abc", nil, 400)
	e.json(tok, "GET", "/v1/memory/brief?project=P&session=bad%20session%0A", nil, 400)
	st := e.json(tok, "GET", "/v1/memory/status?project=P", nil, 200)
	del := st["delivery"].(map[string]any)
	if st["notes"].(float64) != 152 || del["last_session"] != "s1" || len(del["delivered"].([]any)) != 2 || len(del["not_delivered"].([]any)) != 2 {
		t.Fatalf("status: %v", st)
	}
	rec := e.json(tok, "POST", "/v1/memory/recall?session=s9", map[string]any{"project": "P", "pages": []string{"p-key-files-1"}}, 200)
	if len(rec["notes"].([]any)) != 40 {
		t.Fatalf("a page by recall: %d", len(rec["notes"].([]any)))
	}
	one := rec["notes"].([]any)[0].(map[string]any)
	byRef := e.json(tok, "POST", "/v1/memory/recall", map[string]any{"project": "P", "refs": []string{one["ref"].(string)}}, 200)
	if len(byRef["notes"].([]any)) != 1 || byRef["notes"].([]any)[0].(map[string]any)["body"] != "what it does" {
		t.Fatalf("by ref: %v", byRef)
	}
	ps := e.json(tok, "GET", "/v1/memory/projects", nil, 200)
	if p := ps["projects"].([]any); len(p) != 1 || p[0].(map[string]any)["name"] != "P" || p[0].(map[string]any)["notes"].(float64) != 152 {
		t.Fatalf("projects: %v", ps)
	}
}

func TestListPatchAndRetract(t *testing.T) {
	e := newEnv(t)
	tok := e.token("memory/*")
	c := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "finding", "title": "wrong", "body": "a mistaken claim"}, 201)
	id := c["id"].(string)
	if l := e.json(tok, "GET", "/v1/memory/notes?project=P&q=mistaken", nil, 200)["notes"].([]any); len(l) != 1 {
		t.Fatalf("list: %v", l)
	}
	e.json(tok, "GET", "/v1/memory/notes?project=P&kind=gossip", nil, 400)
	e.json(tok, "GET", "/v1/memory/notes?project=P&limit=x", nil, 400)
	e.json(tok, "PATCH", "/v1/memory/notes/"+id, map[string]any{"status": "superseded"}, 400)
	e.json(tok, "PATCH", "/v1/memory/notes/"+id, map[string]any{"colour": "red"}, 400)
	e.json(tok, "PATCH", "/v1/memory/notes/NOPE", map[string]any{"status": "retracted"}, 404)
	if resp, raw := e.do(tok, "PATCH", "/v1/memory/notes/"+id, map[string]any{"status": "retracted"}); resp.StatusCode != 204 {
		t.Fatalf("retract: %d %s", resp.StatusCode, raw)
	}
	if l := e.json(tok, "GET", "/v1/memory/notes?project=P", nil, 200)["notes"].([]any); len(l) != 0 {
		t.Fatalf("a retracted note leaves the default list: %v", l)
	}
	if l := e.json(tok, "GET", "/v1/memory/notes?project=P&status=any", nil, 200)["notes"].([]any); len(l) != 1 || l[0].(map[string]any)["status"] != "retracted" {
		t.Fatalf("status=any: %v", l)
	}
	if b := e.json(tok, "GET", "/v1/memory/brief?project=P", nil, 200); strings.Contains(b["body"].(string), "mistaken") {
		t.Fatal("a retracted note leaves the brief")
	}
	// supersede through the API
	a := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "decision", "title": "old way", "body": "x"}, 201)
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "decision", "title": "new way", "body": "y", "supersedes": a["id"]}, 201)
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "decision", "title": "again", "body": "z", "supersedes": a["id"]}, 400)
	if b := e.json(tok, "GET", "/v1/memory/brief?project=P", nil, 200); strings.Contains(b["body"].(string), "old way") || !strings.Contains(b["body"].(string), "new way") {
		t.Fatalf("supersede: %v", b["body"])
	}
}

func TestRequestHardening(t *testing.T) {
	e := newEnv(t)
	tok := e.token("memory/*")
	r, _ := http.NewRequest("POST", e.srv.URL+"/v1/memory/notes", strings.NewReader(`{"project":"P","kind":"state","title":"t","body":"b"} {"extra":1}`))
	r.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("trailing data after the JSON object: %d", resp.StatusCode)
	}
	for _, p := range []string{"/v1/memory/nothing", "/v1/memory/brief/extra"} {
		if resp, _ := e.do(tok, "GET", p, nil); resp.StatusCode != 404 {
			t.Fatalf("%s: %d", p, resp.StatusCode)
		}
	}
	if resp, _ := e.do(tok, "DELETE", "/v1/memory/notes/x", nil); resp.StatusCode != 405 {
		t.Fatalf("delete is not offered: %d", resp.StatusCode)
	}
}

// The console's Agent setup page (web/src/pages/AgentSetup.tsx readScopes/writeScopes) mints both spellings: memory/brief|recall|remember
// for these REST hooks and memory/memory_* for the MCP tools. A token made by the page must work on every route here, and the
// read-only page token must still refuse writes.
func TestTokensMintedByTheSetupPageServeTheHooks(t *testing.T) {
	e := newEnv(t)
	read := []string{"memory/brief", "memory/recall", "memory/memory_projects", "memory/memory_brief", "memory/memory_recall"}
	write := append(append([]string{}, read...), "memory/remember", "memory/memory_remember", "memory/memory_handoff")
	reader, writer := e.token(read...), e.token(write...)
	e.json(writer, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "t", "body": "b"}, 201)
	e.json(writer, "POST", "/v1/memory/handoff", map[string]any{"project": "P", "summary": "s"}, 201)
	for _, p := range []string{"/v1/memory/brief?project=P", "/v1/memory/projects", "/v1/memory/status", "/v1/memory/notes?project=P"} {
		if resp, raw := e.do(reader, "GET", p, nil); resp.StatusCode != 200 {
			t.Fatalf("%s with the page's read scopes: %d %s", p, resp.StatusCode, raw)
		}
	}
	e.json(reader, "POST", "/v1/memory/recall", map[string]any{"query": "t", "project": "P"}, 200)
	for _, c := range []struct{ path string }{{"/v1/memory/notes"}, {"/v1/memory/handoff"}} {
		if resp, _ := e.do(reader, "POST", c.path, map[string]any{"project": "P", "kind": "state", "title": "x", "body": "y", "summary": "s"}); resp.StatusCode != 403 {
			t.Fatalf("read-only page token wrote to %s: %d", c.path, resp.StatusCode)
		}
	}
}

func TestKeyedNotesOverHTTP(t *testing.T) {
	e := newEnv(t)
	tok := e.token("memory/*")
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "key": "cammut.deployed", "title": "Cammut deployed", "body": "version 0.2.0"}, 201)
	v2 := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "key": "cammut.deployed", "title": "Cammut deployed", "body": "version 0.3.0"}, 201)
	if v2["key"] != "cammut.deployed" {
		t.Fatalf("create echoes the key: %v", v2)
	}
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "key": "bad key", "title": "t", "body": "b"}, 400)
	b := e.json(tok, "GET", "/v1/memory/brief?project=P&tier=full", nil, 200)["body"].(string)
	if !strings.Contains(b, "0.3.0") || strings.Contains(b, "0.2.0") {
		t.Fatalf("brief: %s", b)
	}
	h := e.json(tok, "GET", "/v1/memory/history?project=P&key=cammut.deployed", nil, 200)["notes"].([]any)
	if len(h) != 2 || h[0].(map[string]any)["status"] != "active" || h[1].(map[string]any)["status"] != "superseded" {
		t.Fatalf("history: %v", h)
	}
	e.json(tok, "GET", "/v1/memory/history?project=P&key=nope", nil, 404)
	e.json(e.token("memory/brief"), "GET", "/v1/memory/history?project=P&key=cammut.deployed", nil, 403)
}

func TestEpistemicGateOverHTTP(t *testing.T) {
	e := newEnv(t)
	writer := e.token("memory/brief", "memory/recall", "memory/remember")
	admin := e.token("memory/*")
	e.json(writer, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "decision", "title": "Use FTS5", "body": "it ships in the driver"}, 201)
	sp := e.json(writer, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "finding", "title": "Hiring plan", "body": "guess: hire three engineers", "epistemic": "speculative"}, 201)
	e.json(writer, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "finding", "title": "t", "body": "b", "epistemic": "observed"}, 400)
	if b := e.json(writer, "GET", "/v1/memory/brief?project=P&tier=full", nil, 200)["body"].(string); strings.Contains(b, "Hiring plan") {
		t.Fatal("speculative note in the brief")
	}
	if n := e.json(writer, "POST", "/v1/memory/recall", map[string]any{"project": "P", "query": "hire engineers"}, 200)["notes"].([]any); len(n) != 0 {
		t.Fatalf("recall leaks: %v", n)
	}
	n := e.json(writer, "POST", "/v1/memory/recall", map[string]any{"project": "P", "query": "hire engineers", "include_speculative": true}, 200)["notes"].([]any)
	if len(n) != 1 || n[0].(map[string]any)["epistemic"] != "speculative" {
		t.Fatalf("explicit recall: %v", n)
	}
	id := sp["id"].(string)
	e.json(writer, "POST", "/v1/memory/confirm", map[string]any{"id": id, "epistemic": "observed"}, 400)
	if c := e.json(writer, "POST", "/v1/memory/confirm", map[string]any{"id": id, "epistemic": "inferred"}, 200); c["epistemic"] != "inferred" {
		t.Fatalf("confirm: %v", c)
	}
	if c := e.json(admin, "POST", "/v1/memory/confirm", map[string]any{"id": id, "epistemic": "observed"}, 200); c["epistemic"] != "observed" {
		t.Fatalf("admin confirm: %v", c)
	}
	e.json(e.token("memory/brief"), "POST", "/v1/memory/confirm", map[string]any{"id": id, "epistemic": "inferred"}, 403)
	e.json(writer, "POST", "/v1/memory/confirm", map[string]any{"id": "NOPE", "epistemic": "inferred"}, 404)
}

func TestRecallAbstainsInsteadOfReturningWeakHits(t *testing.T) {
	e := newEnv(t)
	tok := e.token("memory/*")
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "howto", "title": "Run the gate", "body": "bash dev/gate.sh runs the Go tests"}, 201)
	good := e.json(tok, "POST", "/v1/memory/recall", map[string]any{"project": "P", "query": "go tests"}, 200)
	if _, present := good["abstained"]; present || len(good["notes"].([]any)) != 1 {
		t.Fatalf("a real hit carries no abstained field: %v", good)
	}
	none := e.json(tok, "POST", "/v1/memory/recall", map[string]any{"project": "P", "query": "recipe for tomato soup"}, 200)
	if none["abstained"] != "below_threshold" || len(none["notes"].([]any)) != 0 {
		t.Fatalf("off-topic query must abstain: %v", none)
	}
}

type textEmb map[string][]float32

func (textEmb) Model() string { return "fake" }
func (e textEmb) Embed(_ context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		v, ok := e[t]
		if !ok {
			v = []float32{0, 0, 1}
		}
		out[i] = v
	}
	return out, nil
}

func newEnvWithEmbedder(t *testing.T, emb memory.Embedder) (*env, *memory.Service) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "g.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ms := memory.NewStore(st.DB(), nil)
	svc := memory.NewService(ms, memory.NewRanker(ms, emb, nil), func(a store.Audit) { st.AddAudit(a) }, nil)
	h := gateway.Handler(gateway.Deps{Store: st, Mgr: upstream.NewManager(func(string) string { return "" }), Limiter: ratelimit.New(1000, 1000), Memory: New(svc, nil)})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &env{t: t, srv: srv, st: st}, svc
}

func TestRememberReportsDuplicatesAndPossibleSupersedes(t *testing.T) {
	emb := textEmb{
		"Host\nalpha": {1, 0, 0},
		"Host\nalfa":  {0.95, 0.312, 0},
		"Port\n80":    {0, 1, 0},
		"Port\n8080":  {0, 0.88, 0.475},
	}
	e, svc := newEnvWithEmbedder(t, emb)
	tok := e.token("memory/*")
	a := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "Host", "body": "alpha"}, 201)
	svc.Wait()
	dup := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "Host", "body": "alfa"}, 200)
	if dup["duplicate_of"] != a["id"] || dup["id"] != nil || dup["stored"] != false {
		t.Fatalf("duplicate: %v", dup)
	}
	forced := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "Host", "body": "alfa", "force": true}, 201)
	if forced["id"] == nil {
		t.Fatalf("forced: %v", forced)
	}
	p := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "Port", "body": "80"}, 201)
	svc.Wait()
	c := e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "state", "title": "Port", "body": "8080"}, 201)
	ps, _ := c["possible_supersedes"].([]any)
	if len(ps) != 1 || ps[0].(map[string]any)["id"] != p["id"] || ps[0].(map[string]any)["cosine"].(float64) < 0.85 {
		t.Fatalf("possible_supersedes: %v", c)
	}
}

func TestListLeavesOutSpeculativeNotesUnlessAsked(t *testing.T) {
	e := newEnv(t)
	tok := e.token("memory/*")
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "finding", "title": "Fact", "body": "solid"}, 201)
	e.json(tok, "POST", "/v1/memory/notes", map[string]any{"project": "P", "kind": "finding", "title": "Guess", "body": "maybe", "epistemic": "speculative"}, 201)
	if l := e.json(tok, "GET", "/v1/memory/notes?project=P", nil, 200)["notes"].([]any); len(l) != 1 {
		t.Fatalf("default list hides guesses: %v", l)
	}
	if l := e.json(tok, "GET", "/v1/memory/notes?project=P&include_speculative=true", nil, 200)["notes"].([]any); len(l) != 2 {
		t.Fatalf("asked for: %v", l)
	}
}
