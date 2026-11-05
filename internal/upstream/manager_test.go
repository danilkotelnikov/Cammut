package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
)

func echo() fakemcp.Tool {
	return fakemcp.Tool{Name: "echo", Description: "Echo a message back", Run: func(a map[string]any) string { return fmt.Sprint(a["msg"]) }}
}

func newMgr(env map[string]string, ups ...store.Upstream) *Manager {
	m := NewManager(func(k string) string { return env[k] })
	m.Set(ups)
	return m
}

func text(t *testing.T, r *mcp.CallToolResult) string {
	t.Helper()
	if len(r.Content) == 0 {
		t.Fatal("empty content")
	}
	tc, ok := r.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("content is %T", r.Content[0])
	}
	return tc.Text
}

func TestEntriesAndCall(t *testing.T) {
	ts := fakemcp.New(t, "", echo())
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	ctx := context.Background()
	entries, errs := m.Entries(ctx, nil)
	if len(errs) != 0 || len(entries) != 1 || entries[0].Key() != "fake/echo" || entries[0].Description != "Echo a message back" {
		t.Fatalf("entries=%+v errs=%v", entries, errs)
	}
	res, err := m.Call(ctx, "fake", "echo", json.RawMessage(`{"msg":"hello"}`))
	if err != nil || text(t, res) != "hello" {
		t.Fatalf("res=%v err=%v", res, err)
	}
	// a second call after the first call's context is gone must still work (session outlives per-call contexts)
	res, err = m.Call(context.Background(), "fake", "echo", json.RawMessage(`{"msg":"again"}`))
	if err != nil || text(t, res) != "again" {
		t.Fatalf("res=%v err=%v", res, err)
	}
}

func TestBearerComesFromEnvironment(t *testing.T) {
	ts := fakemcp.New(t, "s3cret", echo())
	up := store.Upstream{Name: "fake", URL: ts.URL, BearerEnv: "FAKE_KEY", Enabled: true}
	ok := newMgr(map[string]string{"FAKE_KEY": "s3cret"}, up)
	if _, err := ok.Call(context.Background(), "fake", "echo", json.RawMessage(`{"msg":"x"}`)); err != nil {
		t.Fatalf("with key: %v", err)
	}
	bad := newMgr(map[string]string{}, up)
	if _, err := bad.Call(context.Background(), "fake", "echo", json.RawMessage(`{"msg":"x"}`)); err == nil {
		t.Fatal("without the key the upstream must reject")
	}
}

func TestRetryAfterSessionDies(t *testing.T) {
	ts := fakemcp.New(t, "", echo())
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	ctx := context.Background()
	if _, err := m.Call(ctx, "fake", "echo", json.RawMessage(`{"msg":"1"}`)); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	cs := m.conns["fake"]
	m.mu.Unlock()
	if cs == nil {
		t.Fatal("expected a live session")
	}
	cs.Close() // simulate the upstream dropping our session
	res, err := m.Call(ctx, "fake", "echo", json.RawMessage(`{"msg":"2"}`))
	if err != nil || text(t, res) != "2" {
		t.Fatalf("expected a transparent reconnect, got res=%v err=%v", res, err)
	}
}

func TestUnreachableIsFastAndIsolated(t *testing.T) {
	good := fakemcp.New(t, "", echo())
	dead := fakemcp.New(t, "", echo())
	deadURL := dead.URL
	dead.Close()
	m := newMgr(nil,
		store.Upstream{Name: "good", URL: good.URL, Enabled: true},
		store.Upstream{Name: "dead", URL: deadURL, Enabled: true})
	start := time.Now()
	entries, errs := m.Entries(context.Background(), nil)
	if len(entries) != 1 || entries[0].Upstream != "good" {
		t.Fatalf("entries=%+v", entries)
	}
	if errs["dead"] == nil || errs["good"] != nil {
		t.Fatalf("errs=%v", errs)
	}
	// second round must come from the failure backoff, not another connect attempt
	start2 := time.Now()
	_, errs = m.Entries(context.Background(), nil)
	if errs["dead"] == nil || time.Since(start2) > time.Since(start)+500*time.Millisecond {
		t.Fatalf("errs=%v took %v", errs, time.Since(start2))
	}
	if _, err := m.Call(context.Background(), "dead", "echo", nil); err == nil {
		t.Fatal("a call to a dead upstream must fail")
	}
}

func TestCallTimeout(t *testing.T) {
	slow := fakemcp.Tool{Name: "slow", Description: "sleeps", Run: func(map[string]any) string { time.Sleep(1500 * time.Millisecond); return "late" }}
	ts := fakemcp.New(t, "", slow)
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	m.timeout = 200 * time.Millisecond
	start := time.Now()
	_, err := m.Call(context.Background(), "fake", "slow", nil)
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("err=%v after %v", err, time.Since(start))
	}
}

func TestSetDropsRemovedAndDisabled(t *testing.T) {
	ts := fakemcp.New(t, "", echo())
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	if !m.Has("fake") {
		t.Fatal("fake should be registered")
	}
	m.Set([]store.Upstream{{Name: "fake", URL: ts.URL, Enabled: false}})
	if m.Has("fake") || len(m.Names()) != 0 {
		t.Fatal("disabled upstreams must disappear")
	}
	if _, err := m.Call(context.Background(), "fake", "echo", nil); err == nil || !strings.Contains(err.Error(), "unknown upstream") {
		t.Fatalf("err=%v", err)
	}
}
