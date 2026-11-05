package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"cammut/internal/version"
)

func do(t *testing.T, db string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(append(args, "-db", db), &out)
	return out.String(), err
}

func TestTokenCommands(t *testing.T) {
	db := filepath.Join(t.TempDir(), "c.db")
	out, err := do(t, db, "token", "create", "-label", "codex", "-scopes", "hindsight/*,openviking/find")
	if err != nil || !strings.Contains(out, "cmt_") || !strings.Contains(out, "shown once") {
		t.Fatalf("create: %q %v", out, err)
	}
	out, err = do(t, db, "token", "list")
	if err != nil || !strings.Contains(out, "codex") || !strings.Contains(out, "hindsight/*") || strings.Contains(out, "cmt_") {
		t.Fatalf("list must show label and scopes but never a token: %q %v", out, err)
	}
	if _, err := do(t, db, "token", "create", "-label", "codex"); err == nil {
		t.Fatal("duplicate label must fail")
	}
	if out, err = do(t, db, "token", "scopes", "-label", "codex", "-scopes", "hindsight/*,github/*"); err != nil || !strings.Contains(out, "github/*") {
		t.Fatalf("scopes: %q %v", out, err)
	}
	if out, _ = do(t, db, "token", "list"); !strings.Contains(out, "github/*") {
		t.Fatalf("list after scopes: %q", out)
	}
	if _, err = do(t, db, "token", "scopes", "-label", "ghost", "-scopes", "a"); err == nil {
		t.Fatal("scopes for an unknown label must fail")
	}
	if out, err = do(t, db, "token", "revoke", "-label", "codex"); err != nil || !strings.Contains(out, "revoked") {
		t.Fatalf("revoke: %q %v", out, err)
	}
	if _, err = do(t, db, "token", "revoke", "-label", "ghost"); err == nil {
		t.Fatal("revoking an unknown label must fail")
	}
}

func TestTokenProfileFlag(t *testing.T) {
	db := filepath.Join(t.TempDir(), "p.db")
	out, err := do(t, db, "token", "create", "-label", "warp", "-scopes", "memory/*", "-profile", "direct:memory")
	if err != nil || !strings.Contains(out, "profile: direct:memory") || !strings.Contains(out, "cmt_") {
		t.Fatalf("create with a profile: %q %v", out, err)
	}
	if out, err = do(t, db, "token", "create", "-label", "plain", "-scopes", "memory/*"); err != nil || !strings.Contains(out, "profile: lazy") {
		t.Fatalf("the default profile is lazy: %q %v", out, err)
	}
	if _, err = do(t, db, "token", "create", "-label", "bad", "-scopes", "x", "-profile", "direct:Bad Name"); err == nil {
		t.Fatal("an invalid profile must be refused")
	}
}

func TestUpstreamCommands(t *testing.T) {
	db := filepath.Join(t.TempDir(), "c.db")
	if _, err := do(t, db, "upstream", "add", "-name", "hindsight", "-url", "http://127.0.0.1:8888/mcp/x/", "-bearer-env", "HINDSIGHT_KEY"); err != nil {
		t.Fatal(err)
	}
	if _, err := do(t, db, "upstream", "add", "-name", "evil", "-url", "http://169.254.169.254/"); err == nil {
		t.Fatal("metadata addresses must be refused")
	}
	out, err := do(t, db, "upstream", "list")
	if err != nil || !strings.Contains(out, "hindsight") || !strings.Contains(out, "HINDSIGHT_KEY") || strings.Contains(out, "evil") {
		t.Fatalf("list: %q %v", out, err)
	}
	if out, err = do(t, db, "upstream", "rm", "-name", "hindsight"); err != nil || !strings.Contains(out, "removed") {
		t.Fatalf("rm: %q %v", out, err)
	}
}

func TestUnknownCommand(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"bogus"}, &out); err == nil {
		t.Fatal("unknown commands must fail")
	}
	if err := run([]string{"version"}, &out); err != nil || !strings.Contains(out.String(), version.Version) {
		t.Fatalf("version: %q %v", out.String(), err)
	}
}
