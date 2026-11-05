package memoryapi

import (
	"strings"
	"testing"
)

func TestCheckpointRESTRequiresScopedTokensAndDoesNotConfirmInjection(t *testing.T) {
	e := newEnv(t)
	reader := e.token("memory/brief")
	writer := e.token("memory/remember", "memory/brief")
	p := "p_11111111111111111111111111111111"
	w := "w_11111111111111111111111111111111"
	body := map[string]any{
		"project_id": p, "workspace_id": w, "project": "Cammut",
		"agent": "claude-code", "session_id": "native-claude",
		"source_revision": "cc:s1:1", "parent_revision": "",
		"goal": "Finish the task", "decisions": []string{"Use explicit state"},
		"open_tasks": []string{"Run tests"}, "next_actions": []string{"Continue"},
		"artifact_refs": []string{"adapters/fixtures/continuity-acceptance.json"},
		"validation":    []string{"Synthetic only"},
	}
	if resp, _ := e.do(reader, "POST", "/v1/memory/checkpoints", body); resp.StatusCode != 403 {
		t.Fatalf("read-only token wrote a checkpoint: %d", resp.StatusCode)
	}
	created := e.json(writer, "POST", "/v1/memory/checkpoints", body, 201)
	if created["state"] != "server_durable" || created["duplicate"] != false {
		t.Fatalf("checkpoint receipt: %+v", created)
	}
	duplicate := e.json(writer, "POST", "/v1/memory/checkpoints", body, 200)
	if duplicate["duplicate"] != true {
		t.Fatalf("idempotent replay: %+v", duplicate)
	}
	got := e.json(reader, "GET", "/v1/memory/checkpoints?project_id="+p+"&workspace_id="+w, nil, 200)
	cp := got["checkpoint"].(map[string]any)
	if cp["goal"] != "Finish the task" || cp["source_revision"] != "cc:s1:1" {
		t.Fatalf("checkpoint not restored: %+v", cp)
	}
	if _, ok := got["confirmed"]; ok {
		t.Fatal("a server-side read cannot confirm client injection")
	}
	if _, ok := got["delivery"]; ok {
		t.Fatal("a server-side read is not a client delivery receipt")
	}
	e.json(reader, "GET", "/v1/memory/checkpoints?project_id="+p+"&workspace_id=w_22222222222222222222222222222222", nil, 404)
	if resp, _ := e.do(reader, "GET", "/v1/memory/checkpoints?project_id="+p+"&workspace_id=../other", nil); resp.StatusCode != 400 {
		t.Fatalf("invalid worktree id: %d", resp.StatusCode)
	}
	stale := map[string]any{}
	for key, value := range body {
		stale[key] = value
	}
	stale["source_revision"] = "cx:s2:2"
	e.json(writer, "POST", "/v1/memory/checkpoints", stale, 409)
	stale["parent_revision"] = "cc:s1:1"
	stale["agent"] = "codex"
	stale["session_id"] = "native-codex"
	e.json(writer, "POST", "/v1/memory/checkpoints", stale, 201)
	current := e.json(reader, "GET", "/v1/memory/checkpoints?project_id="+p+"&workspace_id="+w, nil, 200)
	if current["checkpoint"].(map[string]any)["source_revision"] != "cx:s2:2" {
		t.Fatalf("causal successor was not current: %+v", current)
	}
	bad := map[string]any{}
	for key, value := range body {
		bad[key] = value
	}
	bad["project_id"] = strings.Repeat("x", 40)
	e.json(writer, "POST", "/v1/memory/checkpoints", bad, 400)
}

func TestCheckpointRoutesRefuseTokensWithoutMemoryScopes(t *testing.T) {
	e := newEnv(t)
	other := e.token("github/*")
	p, w := "p_11111111111111111111111111111111", "w_11111111111111111111111111111111"
	if resp, _ := e.do(other, "GET", "/v1/memory/checkpoints?project_id="+p+"&workspace_id="+w, nil); resp.StatusCode != 403 {
		t.Fatalf("read without memory scope: %d", resp.StatusCode)
	}
	if resp, _ := e.do(other, "POST", "/v1/memory/checkpoints", map[string]any{"project_id": p}); resp.StatusCode != 403 {
		t.Fatalf("write without memory scope: %d", resp.StatusCode)
	}
	if resp, _ := e.do("", "GET", "/v1/memory/checkpoints?project_id="+p+"&workspace_id="+w, nil); resp.StatusCode != 401 && resp.StatusCode != 403 {
		t.Fatalf("no token: %d", resp.StatusCode)
	}
}
