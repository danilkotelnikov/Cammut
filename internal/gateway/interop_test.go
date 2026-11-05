package gateway_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"cammut/internal/testutil/gwenv"
)

// The Go SDK client is the same code base as the server, so it proves little about other clients. These run the
// official Python and TypeScript SDK clients (the languages cloud agent platforms are written in) against the
// gateway, in the JSON-response mode it uses. Each is skipped when its runtime or SDK is not installed.

func TestInteropWithOfficialPythonClient(t *testing.T) {
	py, err := exec.LookPath("python")
	if err != nil {
		if py, err = exec.LookPath("python3"); err != nil {
			t.Skip("no python")
		}
	}
	if exec.Command(py, "-c", "import mcp").Run() != nil {
		t.Skip("python has no mcp package")
	}
	interop(t, py, "testdata/interop_client.py", nil)
}

// Set CAMMUT_INTEROP_SDK to a node_modules/@modelcontextprotocol/sdk directory (1.x, with dist/esm) to run this one.
func TestInteropWithOfficialNodeClient(t *testing.T) {
	sdk := os.Getenv("CAMMUT_INTEROP_SDK")
	node, err := exec.LookPath("node")
	if sdk == "" || err != nil {
		t.Skip("set CAMMUT_INTEROP_SDK to run the TypeScript SDK client")
	}
	interop(t, node, "testdata/interop_client.mjs", []string{"CAMMUT_INTEROP_SDK=" + sdk})
}

func interop(t *testing.T, bin, script string, env []string) {
	t.Helper()
	e := gwenv.New(t)
	tok := e.TokenProfile(t, "interop", "direct:memory", cloudScopes...)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, script)
	cmd.Env = append(append(os.Environ(), "URL="+e.URL()+"/mcp", "TOK="+tok), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %v\n%s", script, err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var got struct {
		Server        string
		Tools         []string
		RememberError bool `json:"remember_error"`
		Recall        string
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &got); err != nil {
		t.Fatalf("output: %s", out)
	}
	if got.Server != "cammut" || got.RememberError || !strings.Contains(got.Recall, "official") {
		t.Fatalf("client saw: %+v", got)
	}
	if strings.Join(got.Tools, ",") != "memory__memory_brief,memory__memory_handoff,memory__memory_recall,memory__memory_remember" {
		t.Fatalf("tools: %v", got.Tools)
	}
}
