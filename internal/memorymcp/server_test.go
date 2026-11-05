package memorymcp_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/memory"
	"cammut/internal/store"
	"cammut/internal/testutil/gwenv"
)

var memoryActor = memory.Actor{SkipAudit: true}

func noteFilter(project string) memory.NoteFilter { return memory.NoteFilter{Project: project} }

func TestMemoryUpstreamIsVisibleScopedAndAudited(t *testing.T) {
	e := gwenv.New(t) // gateway + store + manager with the memory local upstream mounted
	full := e.Client(t, e.Token(t, "cc", "memory/*"))
	servers := e.Call(t, full, "cammut_servers", nil)
	if !strings.Contains(servers, `"name":"memory"`) || !strings.Contains(servers, `"tools":7`) {
		t.Fatalf("servers: %s", servers)
	}
	out := e.Call(t, full, "cammut_call", map[string]any{"tool": "memory/memory_remember", "arguments": map[string]any{"project": "Cammut", "kind": "howto", "title": "Gate", "body": "bash dev/gate.sh"}})
	if !strings.Contains(out, `"id"`) {
		t.Fatalf("remember: %s", out)
	}
	brief := e.Call(t, full, "cammut_call", map[string]any{"tool": "memory/memory_brief", "arguments": map[string]any{"project": "Cammut"}})
	if !strings.Contains(brief, "bash dev/gate.sh") {
		t.Fatalf("brief: %s", brief)
	}
	narrow := e.Client(t, e.Token(t, "ro", "memory/memory_brief"))
	if out := e.Call(t, narrow, "cammut_call", map[string]any{"tool": "memory/memory_remember", "arguments": map[string]any{"project": "Cammut", "kind": "howto", "title": "x", "body": "y"}}); !strings.Contains(out, "not found or not permitted") {
		t.Fatalf("narrow token wrote: %s", out)
	}
	foreign := e.Client(t, e.Token(t, "gh", "github/*"))
	if s := e.Call(t, foreign, "cammut_servers", nil); strings.Contains(s, "memory") {
		t.Fatalf("foreign token sees memory: %s", s)
	}
	rows, _ := e.Store().QueryAudit(store.AuditFilter{Upstream: "memory"})
	if len(rows) < 2 {
		t.Fatalf("audit rows: %d", len(rows))
	}
}

func TestEachMCPCallIsAuditedOnceAndTheNoteRemembersWhoWroteIt(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "claude-code", "memory/*"))
	e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/memory_remember", "arguments": map[string]any{"project": "P", "kind": "decision", "title": "T", "body": "B"}})
	e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/memory_handoff", "arguments": map[string]any{"project": "P", "summary": "stopping here"}})
	rows, _ := e.Store().QueryAudit(store.AuditFilter{Upstream: "memory"})
	tools := map[string]int{}
	for _, r := range rows {
		tools[r.Tool]++
	}
	if tools["memory_remember"] != 1 || tools["memory_handoff"] != 1 || tools["remember"] != 0 || tools["handoff"] != 0 {
		t.Fatalf("one gateway audit row per call and no service-level duplicate: %v", tools)
	}
	notes, _ := e.Svc.Notes(memoryActor, noteFilter("P"))
	agents := map[string]bool{}
	for _, n := range notes {
		agents[n.SourceAgent] = true
	}
	if len(notes) != 2 || !agents["mcp:claude-code"] {
		t.Fatalf("source agent comes from the token: %+v", notes)
	}
}

func TestToolsValidateTheirArgumentsAndNeverTrustCallerIdentity(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "cc", "memory/*"))
	call := func(tool string, args map[string]any) *mcp.CallToolResult {
		return e.Raw(t, cs, "cammut_call", map[string]any{"tool": "memory/" + tool, "arguments": args})
	}
	for name, args := range map[string]map[string]any{
		"memory_remember": {"project": "P", "kind": "gossip", "title": "x", "body": "y"},
		"memory_brief":    {"project": "P", "_actor": map[string]any{"label": "root"}},
		"memory_recall":   {"query": "x", "project": "../etc"},
		"memory_handoff":  {"project": "P"},
	} {
		if r := call(name, args); !r.IsError {
			t.Fatalf("%s %v must be a tool error, got %v", name, args, r.Content[0])
		}
	}
	for tool, args := range map[string]map[string]any{"memory_brief": {"project": "Nope"}, "memory_recall": {"project": "Nope", "query": "q"}} {
		if r := call(tool, args); !r.IsError || !strings.Contains(r.Content[0].(*mcp.TextContent).Text, "not found") {
			t.Fatalf("%s on an unknown project: %+v", tool, r.Content[0])
		}
	}
	if r := call("memory_projects", map[string]any{}); r.IsError || !strings.Contains(r.Content[0].(*mcp.TextContent).Text, `"projects"`) {
		t.Fatalf("projects: %+v", r)
	}
}

func TestBriefToolReturnsMarkdownDeltaAndTheDeliveredLine(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "cc", "memory/*"))
	tool := func(name string, args map[string]any) string {
		return e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/" + name, "arguments": args})
	}
	tool("memory_remember", map[string]any{"project": "P", "kind": "decision", "title": "Use FTS5", "body": "it ships in the driver"})
	b := tool("memory_brief", map[string]any{"project": "P"})
	lines := strings.Split(strings.TrimSpace(b), "\n")
	if !strings.HasPrefix(b, "# P — brief") || !strings.Contains(b, "## Decisions in force") || lines[len(lines)-1] != "delivered: core; not delivered: none" {
		t.Fatalf("a brief is markdown ending with the delivered line:\n%s", b)
	}
	tool("memory_remember", map[string]any{"project": "P", "kind": "decision", "title": "Second", "body": "later"})
	d := tool("memory_brief", map[string]any{"project": "P", "since_version": 1})
	if !strings.HasPrefix(d, "Brief update to version 2") || !strings.Contains(d, "+ - **Second**") || strings.Contains(d, "## Decisions") {
		t.Fatalf("delta:\n%s", d)
	}
	rec := gwenv.Decode(t, tool("memory_recall", map[string]any{"query": "fts5 driver", "project": "P"}))
	notes := rec["notes"].([]any)
	if len(notes) != 1 || notes[0].(map[string]any)["title"] != "Use FTS5" {
		t.Fatalf("recall: %v", rec)
	}
	ref := notes[0].(map[string]any)["ref"].(string)
	byRef := gwenv.Decode(t, tool("memory_recall", map[string]any{"project": "P", "refs": []string{ref}}))
	if byRef["notes"].([]any)[0].(map[string]any)["body"] != "it ships in the driver" {
		t.Fatalf("by ref: %v", byRef)
	}
}

func TestDirectProfileListsTheToolsNatively(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.TokenProfile(t, "warp", "direct:memory", "memory/*"))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
		if len(tl.Description) == 0 || len(tl.Description) > 240 || tl.InputSchema == nil {
			t.Fatalf("%s: description %d chars, schema %v", tl.Name, len(tl.Description), tl.InputSchema)
		}
	}
	want := []string{"memory__memory_brief", "memory__memory_confirm", "memory__memory_handoff", "memory__memory_history", "memory__memory_projects", "memory__memory_recall", "memory__memory_remember"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("direct tools: %v", names)
	}
	r, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "memory__memory_projects", Arguments: json.RawMessage(`{}`)})
	if err != nil || r.IsError {
		t.Fatalf("direct call: %+v %v", r, err)
	}
	r, err = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "memory__memory_remember", Arguments: json.RawMessage(`{"project":"W","kind":"state","title":"from warp","body":"hello"}`)})
	if err != nil || r.IsError {
		t.Fatalf("direct remember: %+v %v", r, err)
	}
	rows, _ := e.Store().QueryAudit(store.AuditFilter{Upstream: "memory"})
	seen := map[string]bool{}
	for _, row := range rows {
		seen[row.Tool] = true
	}
	if !seen["memory_projects"] || !seen["memory_remember"] {
		t.Fatalf("direct calls are audited like cammut_call: %v", seen)
	}
	notes, _ := e.Svc.Notes(memoryActor, noteFilter("W"))
	if len(notes) != 1 || notes[0].SourceAgent != "mcp:warp" {
		t.Fatalf("%+v", notes)
	}
	// a narrower scope lists a narrower set, and a direct token has no lazy tools
	one := e.Client(t, e.TokenProfile(t, "ro", "direct:memory", "memory/memory_brief"))
	res, _ = one.ListTools(context.Background(), nil)
	if len(res.Tools) != 1 || res.Tools[0].Name != "memory__memory_brief" {
		t.Fatalf("narrow direct token: %+v", res.Tools)
	}
	if r, err := one.CallTool(context.Background(), &mcp.CallToolParams{Name: "memory__memory_remember", Arguments: json.RawMessage(`{}`)}); err == nil && !r.IsError {
		t.Fatal("an unlisted tool must not run")
	}
}

func TestKeyedRememberAndHistoryTool(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "cc", "memory/*"))
	tool := func(name string, args map[string]any) string {
		return e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/" + name, "arguments": args})
	}
	tool("memory_remember", map[string]any{"project": "P", "kind": "state", "key": "cammut.deployed", "title": "Cammut deployed", "body": "version 0.2.0"})
	tool("memory_remember", map[string]any{"project": "P", "kind": "state", "key": "cammut.deployed", "title": "Cammut deployed", "body": "version 0.3.0"})
	if out := tool("memory_remember", map[string]any{"project": "P", "kind": "finding", "title": "x", "body": "y", "force": true}); !strings.Contains(out, `"id"`) {
		t.Fatalf("force is accepted: %s", out)
	}
	brief := tool("memory_brief", map[string]any{"project": "P", "tier": "full"})
	if !strings.Contains(brief, "0.3.0") || strings.Contains(brief, "0.2.0") {
		t.Fatalf("brief: %s", brief)
	}
	h := gwenv.Decode(t, tool("memory_history", map[string]any{"project": "P", "key": "cammut.deployed"}))
	if n := h["notes"].([]any); len(n) != 2 || n[0].(map[string]any)["status"] != "active" {
		t.Fatalf("history: %v", h)
	}
}

func TestEpistemicGateOverMCP(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "cc", "memory/*"))
	call := func(name string, args map[string]any) *mcp.CallToolResult {
		return e.Raw(t, cs, "cammut_call", map[string]any{"tool": "memory/" + name, "arguments": args})
	}
	text := func(r *mcp.CallToolResult) string { return r.Content[0].(*mcp.TextContent).Text }
	r := call("memory_remember", map[string]any{"project": "P", "kind": "finding", "title": "Hiring plan", "body": "guess: hire three engineers", "epistemic": "speculative"})
	if r.IsError {
		t.Fatal(text(r))
	}
	id := gwenv.Decode(t, text(r))["id"].(string)
	if r := call("memory_remember", map[string]any{"project": "P", "kind": "finding", "title": "t", "body": "b", "epistemic": "observed"}); !r.IsError {
		t.Fatal("agents cannot write observed over MCP")
	}
	if n := gwenv.Decode(t, text(call("memory_recall", map[string]any{"project": "P", "query": "hire engineers"})))["notes"].([]any); len(n) != 0 {
		t.Fatalf("recall leaks: %v", n)
	}
	if n := gwenv.Decode(t, text(call("memory_recall", map[string]any{"project": "P", "query": "hire engineers", "include_speculative": true})))["notes"].([]any); len(n) != 1 {
		t.Fatalf("explicit: %v", n)
	}
	if r := call("memory_confirm", map[string]any{"id": id, "epistemic": "observed"}); !r.IsError {
		t.Fatal("observed is not available over MCP")
	}
	c := gwenv.Decode(t, text(call("memory_confirm", map[string]any{"id": id, "epistemic": "inferred"})))
	if c["epistemic"] != "inferred" {
		t.Fatalf("confirm: %v", c)
	}
}

func TestRecallToolAbstains(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "cc", "memory/*"))
	call := func(name string, args map[string]any) map[string]any {
		return gwenv.Decode(t, e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/" + name, "arguments": args}))
	}
	call("memory_remember", map[string]any{"project": "P", "kind": "howto", "title": "Run the gate", "body": "bash dev/gate.sh runs the Go tests"})
	if r := call("memory_recall", map[string]any{"project": "P", "query": "go tests"}); r["abstained"] != nil || len(r["notes"].([]any)) != 1 {
		t.Fatalf("hit: %v", r)
	}
	if r := call("memory_recall", map[string]any{"project": "P", "query": "recipe for tomato soup"}); r["abstained"] != "below_threshold" {
		t.Fatalf("off-topic: %v", r)
	}
}
