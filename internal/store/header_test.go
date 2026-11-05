package store

import (
	"path/filepath"
	"testing"
)

func TestUpstreamKeyHeaderIsStoredAndChecked(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	up := Upstream{Name: "composio", URL: "https://backend.composio.dev/v3/mcp/abc?user_id=u", BearerSecret: "COMPOSIO_API_KEY", AuthHeader: "x-api-key", Enabled: true}
	if err := st.AddUpstream(up); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetUpstream("composio")
	if err != nil || !ok || got.AuthHeader != "x-api-key" {
		t.Fatalf("get: %+v %v %v", got, ok, err)
	}
	list, _ := st.ListUpstreams()
	if len(list) != 1 || list[0].AuthHeader != "x-api-key" {
		t.Fatalf("list: %+v", list)
	}
	for _, bad := range []string{"bad header", "Host", "content-type", "ACCEPT", "x:y", "-x"} {
		up.AuthHeader = bad
		if err := ValidateUpstream(up); err == nil {
			t.Errorf("header %q was accepted", bad)
		}
	}
	up.AuthHeader = ""
	if err := ValidateUpstream(up); err != nil {
		t.Errorf("an empty header means Authorization and must be accepted: %v", err)
	}
}
