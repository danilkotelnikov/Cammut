package gateway_test

// What must hold when /mcp is reachable from the internet (Composio, Warp, remote agents): scopes on both list and
// call, nothing destructive behind a bearer token, brute-force slowing, an audit row per call without bodies,
// redaction on the MCP write path, and response headers. Uses the real gateway with the memory upstream mounted.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"cammut/internal/gateway"
	"cammut/internal/store"
	"cammut/internal/testutil/gwenv"
)

// The four tools a cloud token is meant to hold. memory_projects is deliberately left out.
var cloudScopes = []string{"memory/memory_brief", "memory/memory_recall", "memory/memory_remember", "memory/memory_handoff"}

const listBody = `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`

type got struct {
	Status int
	Header http.Header
	Body   string
}

func post(t *testing.T, base, tok, body string, hdr map[string]string) got {
	t.Helper()
	return do(t, "POST", base+"/mcp", tok, body, hdr)
}

func do(t *testing.T, method, url, tok, body string, hdr map[string]string) got {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return got{resp.StatusCode, resp.Header, string(b)}
}

func names(res *mcp.ListToolsResult) []string {
	var out []string
	for _, tl := range res.Tools {
		out = append(out, tl.Name)
	}
	return out
}

func TestCloudTokenListsAndCallsOnlyItsFourTools(t *testing.T) {
	e := gwenv.New(t)

	// direct profile (what Composio and Warp want): the list itself is filtered
	direct := e.Client(t, e.TokenProfile(t, "cloud-direct", "direct:memory", cloudScopes...))
	res, err := direct.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "memory__memory_brief,memory__memory_handoff,memory__memory_recall,memory__memory_remember"
	if strings.Join(names(res), ",") != want {
		t.Fatalf("tools/list for a scoped cloud token: %v", names(res))
	}
	// calling a tool that is not listed is refused by the protocol, not run
	r, err := direct.CallTool(context.Background(), &mcp.CallToolParams{Name: "memory__memory_projects", Arguments: map[string]any{}})
	if err == nil && !r.IsError {
		t.Fatal("memory_projects ran for a token that does not hold it")
	}
	// and a name outside the profile entirely
	if r, err := direct.CallTool(context.Background(), &mcp.CallToolParams{Name: "cammut_call", Arguments: map[string]any{"tool": "memory/memory_projects"}}); err == nil && !r.IsError {
		t.Fatal("a direct token must not have the lazy tools")
	}
}

func TestCloudTokenOnTheLazyProfileIsScopedToo(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "cloud-lazy", cloudScopes...))
	if s := e.Call(t, cs, "cammut_servers", nil); !strings.Contains(s, `"name":"memory"`) || !strings.Contains(s, `"tools":4`) {
		t.Fatalf("servers must count exactly the four granted tools: %s", s)
	}
	found := e.Call(t, cs, "cammut_search", map[string]any{"query": "memory projects list notes brief recall remember handoff"})
	if strings.Contains(found, "memory_projects") || !strings.Contains(found, "memory/memory_brief") {
		t.Fatalf("search must list only granted tools: %s", found)
	}
	for _, tool := range []string{"memory/memory_projects", "memory/memory_brief_x", "memory/*", "memory"} {
		if r := e.Raw(t, cs, "cammut_describe", map[string]any{"tool": tool}); !r.IsError {
			t.Errorf("describe %q must be refused", tool)
		}
		if r := e.Raw(t, cs, "cammut_call", map[string]any{"tool": tool}); !r.IsError {
			t.Errorf("call %q must be refused", tool)
		}
	}
	if r := e.Raw(t, cs, "cammut_call", map[string]any{"tool": "memory/memory_handoff", "arguments": map[string]any{"project": "P", "summary": "s"}}); r.IsError {
		t.Fatalf("a granted tool must run: %v", r.Content)
	}
}

func TestAnMCPTokenReachesNeitherRESTNorAdminSurfaces(t *testing.T) {
	e := gwenv.New(t)
	tok := e.Token(t, "cloud", cloudScopes...)
	// the REST note API checks memory/brief, memory/recall, memory/remember: the MCP spellings do not satisfy it
	for _, c := range [][2]string{
		{"GET", "/v1/memory/brief?project=P&session=abcdefgh"}, {"POST", "/v1/memory/notes"}, {"PATCH", "/v1/memory/notes/x"}, {"POST", "/v1/memory/recall"}, {"POST", "/v1/memory/handoff"},
	} {
		if r := do(t, c[0], e.URL()+c[1], tok, `{}`, nil); r.Status != 403 {
			t.Errorf("%s %s with an MCP-only token: %d %s", c[0], c[1], r.Status, r.Body)
		}
	}
	// the console API authenticates a cookie session, never a bearer token: not even mounted here, and a bearer is not a session
	if r := do(t, "GET", e.URL()+"/api/v1/tokens", tok, ``, nil); r.Status != 404 && r.Status != 401 {
		t.Errorf("console API with a bearer token: %d", r.Status)
	}
}

// The gateway's own tools and the memory server's are a closed list: a delete, retract or admin tool added later
// has to be added to this test on purpose. memory_history (read) and memory_confirm (raises a note from speculative to
// inferred; "observed" needs a human scope the MCP path never carries) were reviewed and are not destructive.
func TestToolSetIsClosed(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "all", "*"))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names(res), ",") != "cammut_call,cammut_describe,cammut_search,cammut_servers" {
		t.Fatalf("gateway tools: %v", names(res))
	}
	direct := e.Client(t, e.TokenProfile(t, "all-direct", "direct:memory", "*"))
	res, _ = direct.ListTools(context.Background(), nil)
	if strings.Join(names(res), ",") != "memory__memory_brief,memory__memory_confirm,memory__memory_handoff,memory__memory_history,memory__memory_projects,memory__memory_recall,memory__memory_remember" {
		t.Fatalf("memory tools: %v", names(res))
	}
}

func TestSupersedesCannotReachAnotherProjectsNotes(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.Token(t, "w", "memory/*"))
	a := gwenv.Decode(t, e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/memory_remember", "arguments": map[string]any{"project": "A", "kind": "decision", "title": "keep", "body": "mine"}}))
	out := e.Call(t, cs, "cammut_call", map[string]any{"tool": "memory/memory_remember", "arguments": map[string]any{"project": "B", "kind": "decision", "title": "x", "body": "y", "supersedes": a["id"]}})
	if strings.Contains(out, `"id"`) {
		t.Fatalf("a note of project A was superseded from project B: %s", out)
	}
}

// ---- brute force ----

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func fromIP(ip string) map[string]string { return map[string]string{"X-Forwarded-For": ip} }

func TestFailedTokensSlowDownTheClientAddressAndNothingElse(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := gwenv.NewWith(t, func(d *gateway.Deps) { d.Now = clk.Now })
	good := e.Token(t, "owner", "*")
	const evil = "198.51.100.50"

	for i := 0; i < 5; i++ {
		if r := post(t, e.URL(), "cmt_wrong"+fmt.Sprint(i), listBody, fromIP(evil)); r.Status != 401 {
			t.Fatalf("failure %d: %d", i, r.Status)
		}
	}
	r := post(t, e.URL(), good, listBody, fromIP(evil))
	if r.Status != 429 || r.Header.Get("Retry-After") == "" {
		t.Fatalf("after five failures the address is slowed, even for a valid token: %d Retry-After=%q", r.Status, r.Header.Get("Retry-After"))
	}
	if strings.Contains(strings.ToLower(r.Body), "token") && strings.Contains(strings.ToLower(r.Body), "valid") {
		t.Fatalf("the slowdown must not say anything about the token: %q", r.Body)
	}
	// a bad token while blocked is the same 429: no oracle about token existence
	if r2 := post(t, e.URL(), "cmt_nothing", listBody, fromIP(evil)); r2.Status != 429 || r2.Body != r.Body {
		t.Fatalf("blocked, unknown token: %d %q vs %q", r2.Status, r2.Body, r.Body)
	}
	// somebody else is not affected
	if r := post(t, e.URL(), good, listBody, fromIP("203.0.113.9")); r.Status != 200 {
		t.Fatalf("another client address: %d", r.Status)
	}
	// anonymous requests (no Authorization header at all) are not failures
	for i := 0; i < 8; i++ {
		post(t, e.URL(), "", listBody, fromIP("203.0.113.77"))
	}
	if r := post(t, e.URL(), good, listBody, fromIP("203.0.113.77")); r.Status != 200 {
		t.Fatalf("header-less probes must not count: %d", r.Status)
	}
	// the block ends, and the next failure blocks for longer
	clk.Add(61 * time.Second)
	if r := post(t, e.URL(), good, listBody, fromIP(evil)); r.Status != 200 {
		t.Fatalf("after the block: %d", r.Status)
	}
	first := 60
	post(t, e.URL(), "cmt_wrong", listBody, fromIP(evil))
	r = post(t, e.URL(), good, listBody, fromIP(evil))
	var secs int
	fmt.Sscan(r.Header.Get("Retry-After"), &secs)
	if r.Status != 429 || secs <= first {
		t.Fatalf("the second block must be longer than %ds: %d Retry-After=%d", first, r.Status, secs)
	}
}

func TestLoopbackWithoutAForwardedAddressIsNeverThrottled(t *testing.T) {
	// The SSH-tunnel hooks and a proxy that does not forward the client address both look like 127.0.0.1; slowing that
	// address would lock the owner out, so only a client address that is known and not loopback is tracked.
	e := gwenv.New(t)
	good := e.Token(t, "owner", "*")
	for i := 0; i < 20; i++ {
		post(t, e.URL(), "cmt_wrong", listBody, nil)
	}
	if r := post(t, e.URL(), good, listBody, nil); r.Status != 200 {
		t.Fatalf("loopback was throttled: %d", r.Status)
	}
}

func TestUnknownRevokedAndExpiredTokensAreIndistinguishable(t *testing.T) {
	e := gwenv.New(t)
	revoked := e.Token(t, "gone", "*")
	if ok, _ := e.Store().RevokeToken("gone"); !ok {
		t.Fatal("revoke")
	}
	expired, _, err := e.Store().CreateTokenOpts("old", []string{"*"}, time.Now().Add(1100*time.Millisecond), "lazy")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2100 * time.Millisecond)
	var first got
	for i, tok := range []string{"cmt_" + strings.Repeat("0", 64), revoked, expired, "not-even-a-token", "x"} {
		r := post(t, e.URL(), tok, listBody, nil)
		r.Header.Del("Date")
		if i == 0 {
			first = r
		}
		if r.Status != 401 || r.Body != first.Body || fmt.Sprint(r.Header) != fmt.Sprint(first.Header) {
			t.Fatalf("token %d answers differently: %d %q %v vs %d %q %v", i, r.Status, r.Body, r.Header, first.Status, first.Body, first.Header)
		}
	}
}

// ---- audit ----

type forwardedFor struct{ tok, ip string }

func (f forwardedFor) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+f.tok)
	r.Header.Set("X-Forwarded-For", f.ip)
	return http.DefaultTransport.RoundTrip(r)
}

func connect(t *testing.T, e *gwenv.Env, tok, ip string) *mcp.ClientSession {
	t.Helper()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil).Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: e.URL() + "/mcp", HTTPClient: &http.Client{Transport: forwardedFor{tok, ip}}, DisableStandaloneSSE: true, MaxRetries: -1,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func TestEveryMCPCallLeavesOneAuditRowWithoutBodies(t *testing.T) {
	e := gwenv.New(t)
	plain := e.TokenProfile(t, "cloud", "direct:memory", cloudScopes...)
	tok, ok, _ := e.Store().VerifyToken(plain)
	if !ok {
		t.Fatal("token")
	}
	cs := connect(t, e, plain, "198.51.100.7")
	ctx := context.Background()

	if _, err := cs.ListTools(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if r, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "memory__memory_remember", Arguments: map[string]any{"project": "P", "kind": "finding", "title": "audit probe", "body": "SECRET-BODY-TEXT-1234"}}); err != nil || r.IsError {
		t.Fatalf("remember: %v %+v", err, r)
	}
	cs.CallTool(ctx, &mcp.CallToolParams{Name: "memory__memory_projects", Arguments: map[string]any{}}) // not granted

	rows, err := e.Store().QueryAudit(store.AuditFilter{TokenID: tok.ID, Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	byTool := map[string]store.Audit{}
	for _, r := range rows {
		if _, dup := byTool[r.Tool]; dup {
			t.Fatalf("two audit rows for %s: %+v", r.Tool, rows)
		}
		byTool[r.Tool] = r
		if r.IP != "198.51.100.7" || r.TokenID != tok.ID {
			t.Errorf("row lacks token id or client address: %+v", r)
		}
		if blob := fmt.Sprint(r); strings.Contains(blob, "SECRET-BODY-TEXT") || strings.Contains(blob, "audit probe") {
			t.Errorf("an audit row holds request content: %+v", r)
		}
	}
	if l := byTool["tools/list"]; !l.OK || l.Upstream != "cammut" {
		t.Errorf("tools/list: %+v", rows)
	}
	if m := byTool["memory_remember"]; !m.OK || m.Upstream != "memory" {
		t.Errorf("remember: %+v", rows)
	}
	if d, ok := byTool["memory__memory_projects"]; !ok || d.OK {
		t.Errorf("a refused call must be audited as failed: %+v", rows)
	}
}

func TestGatewayToolsAreAudited(t *testing.T) {
	e := gwenv.New(t)
	plain := e.Token(t, "lazy", "memory/*")
	cs := connect(t, e, plain, "203.0.113.4")
	e.Call(t, cs, "cammut_servers", nil)
	e.Call(t, cs, "cammut_search", map[string]any{"query": "brief"})
	e.Call(t, cs, "cammut_describe", map[string]any{"tool": "memory/memory_brief"})
	e.Raw(t, cs, "cammut_call", map[string]any{"tool": "memory/memory_projects", "arguments": "not an object"})
	tools := map[string]bool{}
	rows, _ := e.Store().QueryAudit(store.AuditFilter{Limit: 20})
	for _, r := range rows {
		tools[r.Tool] = true
		if r.IP != "203.0.113.4" {
			t.Errorf("row without the client address: %+v", r)
		}
	}
	for _, want := range []string{"cammut_servers", "cammut_search", "cammut_describe", "cammut_call"} {
		if !tools[want] {
			t.Errorf("no audit row for %s: %+v", want, rows)
		}
	}
}

// ---- redaction on the write path ----

func TestRememberOverMCPRedactsSecretsEverywhereItStores(t *testing.T) {
	e := gwenv.New(t)
	cs := e.Client(t, e.TokenProfile(t, "cloud", "direct:memory", cloudScopes...))
	key := "sk-" + "Zq8Lm2Vn4Xc6Bp9Wd3Ry7Tf1"
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefakefakefake1234567890\nabcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n-----END RSA PRIVATE KEY-----"
	r, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "memory__memory_remember", Arguments: map[string]any{
		"project": "R", "kind": "howto", "title": "deploy with " + key, "body": "use " + key + " then\n" + pem + "\nand password: hunter2hunter2", "tags": []string{"ok"},
	}})
	if err != nil || r.IsError {
		t.Fatalf("remember: %v %+v", err, r)
	}
	out := e.Call(t, cs, "memory__memory_recall", map[string]any{"project": "R", "query": "deploy"})
	for _, leak := range []string{key, "MIIEowIBAAKCAQEA", "hunter2hunter2", "BEGIN RSA PRIVATE KEY"} {
		if strings.Contains(out, leak) {
			t.Errorf("recall returns %q: %s", leak, out)
		}
	}
	if !strings.Contains(out, "[REDACTED:key]") || !strings.Contains(out, "[REDACTED:private-key]") {
		t.Errorf("redaction markers missing: %s", out)
	}
	// nothing in any table of the database, including the full-text shadow tables and the audit log
	dump := dumpDB(t, e.Store())
	for _, leak := range []string{key, "MIIEowIBAAKCAQEA", "hunter2hunter2"} {
		if strings.Contains(dump, leak) {
			t.Errorf("the database holds %q", leak)
		}
	}
	// the handoff path stores free text too
	if r, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "memory__memory_handoff", Arguments: map[string]any{"project": "R", "summary": "token is " + key, "next_steps": []string{"export OPENAI_API_KEY=" + key}}}); err != nil || r.IsError {
		t.Fatalf("handoff: %v %+v", err, r)
	}
	if strings.Contains(dumpDB(t, e.Store()), key) {
		t.Error("the database holds the key after a handoff")
	}
}

func dumpDB(t *testing.T, st *store.Store) string {
	t.Helper()
	var b strings.Builder
	rows, err := st.DB().Query(`SELECT name FROM sqlite_master WHERE type='table'`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		tables = append(tables, n)
	}
	rows.Close()
	for _, n := range tables {
		rs, err := st.DB().Query(`SELECT * FROM "` + n + `"`)
		if err != nil {
			continue // virtual-table internals that cannot be selected from are not stored text
		}
		cols, _ := rs.Columns()
		for rs.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if rs.Scan(ptrs...) == nil {
				for _, v := range vals {
					switch x := v.(type) {
					case []byte:
						b.Write(x)
					default:
						fmt.Fprint(&b, x)
					}
					b.WriteByte(' ')
				}
			}
		}
		rs.Close()
	}
	return b.String()
}

// ---- headers ----

func TestResponseHeadersOnTheMCPEndpoint(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := gwenv.NewWith(t, func(d *gateway.Deps) { d.Now = clk.Now })
	good := e.Token(t, "h", "*")
	huge := `{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"` + strings.Repeat("a", 2<<20) + `"}`
	cases := map[string]got{
		"200":      post(t, e.URL(), good, listBody, nil),
		"202":      post(t, e.URL(), good, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil),
		"401":      post(t, e.URL(), "", listBody, nil),
		"401 bad":  post(t, e.URL(), "cmt_nope", listBody, nil),
		"400":      post(t, e.URL(), good, `[`+listBody+`]`, nil),
		"413":      post(t, e.URL(), good, huge, nil),
		"405":      do(t, "GET", e.URL()+"/mcp", good, ``, map[string]string{"Accept": "text/event-stream"}),
		"OPTIONS":  do(t, "OPTIONS", e.URL()+"/mcp", good, ``, map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}),
		"browser":  post(t, e.URL(), good, listBody, map[string]string{"Origin": "https://evil.example"}),
		"OPT anon": do(t, "OPTIONS", e.URL()+"/mcp", "", ``, map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}),
	}
	for name, r := range cases {
		if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s (%d): Cache-Control=%q", name, r.Status, cc)
		}
		if r.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", name)
		}
		for h := range r.Header {
			if strings.HasPrefix(strings.ToLower(h), "access-control-") {
				t.Errorf("%s: CORS header %s must never be sent", name, h)
			}
		}
	}
	want := map[string]int{"200": 200, "202": 202, "401": 401, "401 bad": 401, "400": 400, "413": 413, "405": 405, "browser": 200}
	for name, code := range want {
		if cases[name].Status != code {
			t.Errorf("%s: %d, want %d", name, cases[name].Status, code)
		}
	}
	// a blocked address answers 429 with the same headers
	for i := 0; i < 5; i++ {
		post(t, e.URL(), "cmt_nope", listBody, fromIP("198.51.100.1"))
	}
	r := post(t, e.URL(), good, listBody, fromIP("198.51.100.1"))
	if r.Status != 429 || r.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("429: %d %q", r.Status, r.Header.Get("Cache-Control"))
	}
}

func TestHealthzRevealsOnlyOK(t *testing.T) {
	e := gwenv.New(t)
	r := do(t, "GET", e.URL()+"/healthz", "", ``, nil)
	if r.Status != 200 || r.Body != "ok\n" {
		t.Fatalf("healthz: %d %q", r.Status, r.Body)
	}
	for h := range r.Header {
		l := strings.ToLower(h)
		if l == "server" || l == "x-powered-by" || strings.HasPrefix(l, "x-cammut") || strings.Contains(l, "version") {
			t.Errorf("healthz header %s", h)
		}
	}
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("healthz is cacheable: %q", r.Header.Get("Cache-Control"))
	}
	if r := do(t, "POST", e.URL()+"/healthz", "", `{}`, nil); r.Body != "ok\n" && r.Status == 200 {
		t.Errorf("healthz POST body: %q", r.Body)
	}
}
