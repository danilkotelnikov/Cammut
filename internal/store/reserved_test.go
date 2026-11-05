package store

import "testing"

func TestTheNameLLMIsReservedForTheGateway(t *testing.T) {
	if err := ValidateUpstream(Upstream{Name: "llm", URL: "https://example.com/mcp", Enabled: true}); err == nil {
		t.Fatal("an MCP upstream called llm would be reachable with a scope that means the LLM gateway")
	}
}
