package admin

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"cammut/internal/oauth"
)

func TestOAuthConsoleApiRunsTheOwnersSideOfTheFlow(t *testing.T) {
	a := newAPI(t, nil)
	svc := a.oa
	s := a.login()
	redirect := "https://gemini.test/cb"

	if a.req("GET", "/api/v1/oauth/clients", nil, "").StatusCode != 401 {
		t.Fatal("the client list needs a session")
	}
	if a.req("POST", "/api/v1/oauth/clients", map[string]any{"name": "Gemini"}, s, func(r *http.Request) { r.Header.Del("X-Requested-With") }).StatusCode != 403 {
		t.Fatal("creating a client needs the CSRF header")
	}
	if a.req("POST", "/api/v1/oauth/clients", map[string]any{"name": "Gemini", "redirect_uris": []string{"http://evil.test/cb"}, "scopes": []string{"hindsight/recall"}}, s).StatusCode != 400 {
		t.Fatal("an http redirect address must be refused")
	}

	resp := a.req("POST", "/api/v1/oauth/clients", map[string]any{"name": "Gemini", "redirect_uris": []string{redirect}, "scopes": []string{"hindsight/recall"}}, s)
	var created struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	decode(t, resp, &created)
	if resp.StatusCode != 201 || !strings.HasPrefix(created.ClientID, "cmc_") || !strings.HasPrefix(created.ClientSecret, "cms_") {
		t.Fatalf("create: %d %+v", resp.StatusCode, created)
	}
	var list []map[string]any
	decode(t, a.req("GET", "/api/v1/oauth/clients", nil, s), &list)
	if len(list) != 1 || list[0]["id"] != created.ClientID {
		t.Fatalf("list: %v", list)
	}
	if raw, _ := json.Marshal(list); strings.Contains(string(raw), created.ClientSecret) {
		t.Fatal("the secret must never be listed again")
	}

	req, err := svc.Begin(oauth.AuthParams{ClientID: created.ClientID, RedirectURI: redirect, State: "st"})
	if err != nil {
		t.Fatal(err)
	}
	if a.req("GET", "/api/v1/oauth/requests/"+req, nil, "").StatusCode != 401 {
		t.Fatal("the consent details need a session")
	}
	var info map[string]any
	r := a.req("GET", "/api/v1/oauth/requests/"+req, nil, s)
	decode(t, r, &info)
	if r.StatusCode != 200 || info["client_name"] != "Gemini" || info["redirect_host"] != "gemini.test" {
		t.Fatalf("request: %d %v", r.StatusCode, info)
	}
	var ok map[string]string
	r = a.req("POST", "/api/v1/oauth/requests/"+req+"/approve", map[string]any{}, s)
	decode(t, r, &ok)
	u, _ := url.Parse(ok["redirect"])
	if r.StatusCode != 200 || u.Host != "gemini.test" || u.Query().Get("code") == "" || u.Query().Get("state") != "st" {
		t.Fatalf("approve: %d %v", r.StatusCode, ok)
	}
	if a.req("POST", "/api/v1/oauth/requests/"+req+"/approve", map[string]any{}, s).StatusCode != 404 {
		t.Fatal("a request can be answered once")
	}

	if _, err := svc.Exchange(oauth.Who{}, created.ClientID, created.ClientSecret, u.Query().Get("code"), redirect, ""); err != nil {
		t.Fatal(err)
	}
	decode(t, a.req("GET", "/api/v1/oauth/clients", nil, s), &list)
	if g, _ := list[0]["grants"].([]any); len(g) != 1 {
		t.Fatalf("grants: %v", list[0]["grants"])
	}

	if a.req("DELETE", "/api/v1/oauth/clients/"+created.ClientID, nil, s).StatusCode != 204 {
		t.Fatal("delete")
	}
	decode(t, a.req("GET", "/api/v1/oauth/clients", nil, s), &list)
	if len(list) != 0 {
		t.Fatalf("the client should be gone: %v", list)
	}
}
