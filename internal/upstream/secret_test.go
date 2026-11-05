package upstream

import (
	"context"
	"encoding/json"
	"testing"

	"cammut/internal/store"
	"cammut/internal/testutil/fakemcp"
)

func TestBearerPrefersTheSecretResolverThenEnvironment(t *testing.T) {
	ts := fakemcp.New(t, "from-vault", echo())
	up := store.Upstream{Name: "fake", URL: ts.URL, BearerSecret: "FAKE_PAT", BearerEnv: "FAKE_KEY", Enabled: true}
	env := map[string]string{"FAKE_KEY": "from-env"}
	m := newMgr(env, up)
	vault := map[string]string{"FAKE_PAT": "from-vault"}
	m.SetSecretResolver(func(name, purpose, host string) (string, error) { return vault[name], nil })
	if _, err := m.Call(context.Background(), "fake", "echo", json.RawMessage(`{"msg":"x"}`)); err != nil {
		t.Fatalf("the vault value must win over the environment: %v", err)
	}

	// the vault value can change without any reconfiguration: it is read per request
	ts2 := fakemcp.New(t, "rotated", echo())
	m2 := newMgr(env, store.Upstream{Name: "fake", URL: ts2.URL, BearerSecret: "FAKE_PAT", Enabled: true})
	m2.SetSecretResolver(func(name, purpose, host string) (string, error) { return vault["FAKE_PAT"], nil })
	if _, err := m2.Call(context.Background(), "fake", "echo", nil); err == nil {
		t.Fatal("the old secret must be rejected by the rotated upstream")
	}
	vault["FAKE_PAT"] = "rotated"
	m2.Set(nil) // a new session after rotation must carry the new value
	m2.Set([]store.Upstream{{Name: "fake", URL: ts2.URL, BearerSecret: "FAKE_PAT", Enabled: true}})
	if _, err := m2.Call(context.Background(), "fake", "echo", json.RawMessage(`{"msg":"x"}`)); err != nil {
		t.Fatalf("after rotating the secret the call must work: %v", err)
	}

	// no resolver entry: fall back to the environment variable
	ts3 := fakemcp.New(t, "from-env", echo())
	m3 := newMgr(env, store.Upstream{Name: "fake", URL: ts3.URL, BearerSecret: "MISSING", BearerEnv: "FAKE_KEY", Enabled: true})
	m3.SetSecretResolver(func(string, string, string) (string, error) { return "", nil })
	if _, err := m3.Call(context.Background(), "fake", "echo", json.RawMessage(`{"msg":"x"}`)); err != nil {
		t.Fatalf("environment fallback: %v", err)
	}
}

func TestProbeBypassesTheCacheAndLeavesItAlone(t *testing.T) {
	ts := fakemcp.New(t, "", echo())
	m := newMgr(nil, store.Upstream{Name: "fake", URL: ts.URL, Enabled: true})
	entries, err := m.Probe(context.Background(), "fake")
	if err != nil || len(entries) != 1 || entries[0].Key() != "fake/echo" {
		t.Fatalf("probe: %+v %v", entries, err)
	}
	m.mu.Lock()
	_, cached := m.cache["fake"]
	m.mu.Unlock()
	if cached {
		t.Fatal("Probe must not populate the shared tool cache")
	}
	if _, err := m.Probe(context.Background(), "ghost"); err == nil {
		t.Fatal("an unknown upstream must be an error")
	}
}
