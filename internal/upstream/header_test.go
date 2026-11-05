package upstream

import (
	"net/http"
	"testing"
)

func TestAKeyHeaderCarriesTheBareKeyAndOnlyToTheUpstreamHost(t *testing.T) {
	var gotKey, gotAuth string
	next := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		gotKey, gotAuth = r.Header.Get("x-api-key"), r.Header.Get("Authorization")
		return &http.Response{StatusCode: 200, Body: http.NoBody, Request: r}, nil
	})
	rt := bearerRT{host: "up.example:443", env: "K", getenv: func(string) string { return "tok" }, header: "x-api-key", next: next}

	req, _ := http.NewRequest("POST", "https://up.example:443/mcp", nil)
	req.Header.Set("Authorization", "Bearer from-the-caller")
	if _, err := rt.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	if gotKey != "tok" {
		t.Fatalf("x-api-key = %q, want the bare key", gotKey)
	}
	if gotAuth != "Bearer from-the-caller" {
		t.Fatalf("a custom key header must leave Authorization alone, got %q", gotAuth)
	}

	gotKey = ""
	other, _ := http.NewRequest("POST", "https://other.example/mcp", nil)
	if _, err := rt.RoundTrip(other); err != nil || gotKey != "" {
		t.Fatalf("the key must not go to another host: %q %v", gotKey, err)
	}
}
