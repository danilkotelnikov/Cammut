import { afterEach, describe, expect, it, vi } from "vitest";
import { CB, ORIGIN, authorizePath, b64u, cookiesOf, csrfOf, fullFlow, get, harness, pkce, post, register, stateOf, toConsent } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("discovery", () => {
  it("serves authorization-server metadata with S256 only", async () => {
    const h = await harness();
    const j = (await (await h.call(get("/.well-known/oauth-authorization-server"))).json()) as Record<string, any>;
    expect(j.issuer).toBe(ORIGIN);
    expect(j.authorization_endpoint).toBe(ORIGIN + "/authorize");
    expect(j.token_endpoint).toBe(ORIGIN + "/token");
    expect(j.registration_endpoint).toBe(ORIGIN + "/register");
    expect(j.code_challenge_methods_supported).toEqual(["S256"]);
    expect(j.scopes_supported).toEqual(["github/*", "hindsight/*", "composio/*", "memory/brief", "memory/remember"]);
  });

  it("protected-resource metadata names the exact /mcp resource", async () => {
    const h = await harness();
    // the 401 challenge points clients at the metadata URL
    const hint = (await h.call(get("/mcp"))).headers.get("WWW-Authenticate")!.match(/resource_metadata="([^"]+)"/)![1];
    expect(hint).toBe(ORIGIN + "/.well-known/oauth-protected-resource/mcp");
    const res = await h.call(new Request(hint));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, any>;
    expect(j.resource).toBe("https://mcp-staging.example/mcp");
    expect(j.authorization_servers).toContain(ORIGIN);
    expect(j.scopes_supported).toContain("memory/remember");
    expect(j.bearer_methods_supported).toEqual(["header"]);
    // the bare well-known path answers the same
    const bare = (await (await h.call(get("/.well-known/oauth-protected-resource"))).json()) as Record<string, any>;
    expect(bare.resource).toBe("https://mcp-staging.example/mcp");
  });
});

describe("registration and PKCE", () => {
  it("registers a client dynamically", async () => {
    const h = await harness();
    const { res, body } = await register(h);
    expect(res.status).toBe(201);
    expect(body.client_id).toBeTruthy();
  });

  it("limits registrations per IP to 10 an hour", async () => {
    const h = await harness();
    const ip = "192.0.2.77";
    for (let i = 0; i < 10; i++) expect((await register(h, "none", ip)).res.status).toBe(201);
    const over = await register(h, "none", ip);
    expect(over.res.status).toBe(429);
  });

  for (const method of ["none", "client_secret_post"] as const) {
    it(`rejects /authorize without PKCE (${method})`, async () => {
      const h = await harness();
      const { body } = await register(h, method);
      const res = await h.call(get(authorizePath(body.client_id)));
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    });
    it(`rejects /authorize with plain PKCE (${method})`, async () => {
      const h = await harness();
      const { body } = await register(h, method);
      const res = await h.call(get(authorizePath(body.client_id, { code_challenge: "abc", code_challenge_method: "plain" })));
      expect(res.status).toBe(400);
    });
  }

  it("shows the sign-in page for S256 and sets a __Host- cookie", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const res = await h.call(get(authorizePath(body.client_id, { code_challenge: challenge, code_challenge_method: "S256" })));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Continue with GitHub");
    expect(text).toContain("Continue with Google");
    expect(text).toContain("/account/tokens/oauth2/github?project=your-appwrite-project");
    expect(text).toContain(encodeURIComponent("https://mcp-staging.example/auth/callback"));
    expect(text).toContain(encodeURIComponent("https://mcp-staging.example/auth/failed"));
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toMatch(/^__Host-cammut-flow=[A-Za-z0-9_-]{40,};/);
    for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) expect(cookie).toContain(flag);
    expect(cookie).not.toContain("Domain");
    expect(h.aw.calls).toHaveLength(0);
  });

  it("puts a CSP on pages", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const res = await h.call(get(authorizePath(body.client_id, { code_challenge: challenge, code_challenge_method: "S256" })));
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("form-action 'self' https://fra.cloud.appwrite.io");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await res.text()).not.toContain("<script");
  });
});

describe("Appwrite callback", () => {
  it("allowed GitHub id gets the consent page; exchange happens first and the session is deleted", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { a, cb, consent } = await toConsent(h, body.client_id, challenge);
    expect(a.status).toBe(200);
    expect(cb.status).toBe(303);
    expect(cb.headers.get("Location")).toBe("/auth/consent");
    expect(cb.headers.get("Location")).not.toMatch(/secret|userId/);
    expect(h.aw.calls).toEqual(["POST /account/sessions/token", "GET /account/identities", "DELETE /account/sessions/current"]);
    expect(consent.status).toBe(200);
    const text = await consent.text();
    expect(text).toContain("Test App wants to use your tools and memory");
    expect(text).toContain("Use tools on: github");
    expect(text).toContain("Read memory");
    expect(text).not.toContain("Write memory"); // not requested
    expect(text).toContain('value="github/*" checked');
    expect(text).toContain("client.example");
    // consent GET makes no further Appwrite call
    expect(h.aw.calls).toHaveLength(3);
  });

  it("reads the session secret from the cookie when the body has none", async () => {
    const h = await harness();
    h.aw.secretIn = "cookie";
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cb } = await toConsent(h, body.client_id, challenge);
    expect(cb.status).toBe(303);
  });

  it("another GitHub id gets a plain 403 and no consent", async () => {
    const h = await harness();
    h.aw.identities = [{ provider: "github", providerUid: "999" }];
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cb, consent } = await toConsent(h, body.client_id, challenge);
    expect(cb.status).toBe(403);
    expect(h.aw.calls).toContain("DELETE /account/sessions/current");
    expect(consent.status).toBe(400); // flow was dropped
  });

  it("a failed token exchange is a 400", async () => {
    const h = await harness();
    h.aw.tokenStatus = 401;
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cb } = await toConsent(h, body.client_id, challenge);
    expect(cb.status).toBe(400);
  });

  it("allows a Google email from the allowlist", async () => {
    const h = await harness({ ALLOWED_GOOGLE_EMAILS: "Owner@Example.com" });
    h.aw.identities = [{ provider: "google", providerUid: "1", providerEmail: "owner@example.com" }];
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cb } = await toConsent(h, body.client_id, challenge);
    expect(cb.status).toBe(303);
  });

  it("sends state to Appwrite and rejects a missing or wrong state before any exchange", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const a = await h.call(get(authorizePath(body.client_id, { code_challenge: challenge, code_challenge_method: "S256" })));
    const state = await stateOf(a);
    expect(state.length).toBeGreaterThan(20);
    const link = (await a.clone().text()).replace(/&#38;|&amp;/g, "&");
    expect(link).toContain("scopes%5B%5D=read%3Auser");
    const jar = cookiesOf(a);
    expect((await h.call(get("/auth/callback?userId=u1&secret=s1", jar))).status).toBe(400);
    expect((await h.call(get("/auth/callback?userId=u1&secret=s1&state=wrong", jar))).status).toBe(400);
    expect(h.aw.calls).toHaveLength(0);
    // the flow survives a bad try; the right state still works
    expect((await h.call(get(`/auth/callback?userId=u1&secret=s1&state=${state}`, jar))).status).toBe(303);
  });

  it("with APPWRITE_API_KEY: key on the exchange, JSON secret used, session deleted via /users", async () => {
    const h = await harness({ APPWRITE_API_KEY: "k-123" });
    h.aw.secretIn = "body";
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cb } = await toConsent(h, body.client_id, challenge);
    expect(cb.status).toBe(303);
    expect(h.aw.keys).toEqual(["k-123"]);
    expect(h.aw.calls).toEqual(["POST /account/sessions/token", "GET /account/identities", "DELETE /users/u1/sessions/sess1"]);
  });

  it("without the key no X-Appwrite-Key is sent", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    await toConsent(h, body.client_id, challenge);
    expect(h.aw.keys).toEqual([null]);
  });

  it("refuses a callback with no flow cookie or a wrong one, without calling Appwrite", async () => {
    const h = await harness();
    expect((await h.call(get("/auth/callback?userId=u&secret=s"))).status).toBe(400);
    const wrong = "__Host-cammut-flow=" + "A".repeat(43);
    expect((await h.call(get("/auth/callback?userId=u&secret=s", wrong))).status).toBe(400);
    expect(h.aw.calls).toHaveLength(0);
  });
});

describe("consent form", () => {
  it("rejects a missing or wrong CSRF token", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cookie } = await toConsent(h, body.client_id, challenge);
    expect((await h.call(post("/auth/consent", { decision: "allow", scope: "github/*" }, cookie))).status).toBe(400);
    expect((await h.call(post("/auth/consent", { csrf: "nope", decision: "allow", scope: "github/*" }, cookie))).status).toBe(400);
  });

  it("Deny redirects with access_denied and state", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cookie, consent } = await toConsent(h, body.client_id, challenge);
    const res = await h.call(post("/auth/consent", { csrf: await csrfOf(consent), decision: "deny" }, cookie));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
  });

  it("cannot grant a scope that was not offered", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cookie, consent } = await toConsent(h, body.client_id, challenge);
    const res = await h.call(post("/auth/consent", { csrf: await csrfOf(consent), decision: "allow", scope: ["memory/remember"] }, cookie));
    expect(res.status).toBe(400);
  });
});

describe("tokens and /mcp", () => {
  it("full flow: token, then /mcp is forwarded with a verifiable pass", async () => {
    const h = await harness();
    const f = await fullFlow(h);
    expect(f.tok.status).toBe(200);
    expect(f.json.expires_in).toBe(3600);
    expect(f.json.refresh_token).toBeTruthy();
    expect(f.json.scope.split(" ").sort()).toEqual(["github/*", "memory/brief"]);

    // a request body that is a stream
    const sent = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sent)); c.close(); } });
    h.origin.reply = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: hi\n\n")); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    const res = await h.call(
      new Request(ORIGIN + "/mcp?x=1", {
        method: "POST",
        body: stream,
        // @ts-expect-error duplex is not in the lib types
        duplex: "half",
        headers: {
          Authorization: "Bearer " + f.json.access_token,
          Cookie: "evil=1",
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
          "CF-Ray": "abc",
          "X-Forwarded-For": "6.6.6.6",
          "Mcp-Session-Id": "s-1",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: hi\n\n");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    expect(h.origin.requests).toHaveLength(1);
    const { url, init } = h.origin.requests[0];
    expect(url).toBe("https://origin-staging.example/mcp?x=1");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(ReadableStream); // streamed, not buffered
    expect(await new Response(init.body as ReadableStream).text()).toBe(sent);

    const hd = new Headers(init.headers);
    expect(hd.get("cf-access-client-id")).toBe("cid");
    expect(hd.get("cf-access-client-secret")).toBe("csecret");
    expect(hd.get("cookie")).toBeNull();
    expect(hd.get("cf-ray")).toBeNull();
    expect(hd.get("cf-connecting-ip")).toBeNull();
    expect(hd.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(hd.get("mcp-session-id")).toBe("s-1");
    expect(hd.get("content-type")).toBe("application/json");

    const auth = hd.get("authorization")!;
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(auth).not.toContain(f.json.access_token);
    const [h64, p64, s64] = auth.slice(7).split(".");
    const dec = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(dec(h64)).toEqual({ alg: "EdDSA", typ: "JWT", kid: "edge-1" });
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, h.publicKey, unb64(s64), new TextEncoder().encode(`${h64}.${p64}`));
    expect(ok).toBe(true);
    const claims = dec(p64);
    expect(Object.keys(claims).sort()).toEqual(["aud", "cip", "exp", "grant", "iat", "iss", "jti", "scope", "sub"]);
    expect(claims.iss).toBe("cammut-edge");
    expect(claims.aud).toBe("cammut-staging");
    expect(claims.sub).toBe("gh:12345");
    expect(claims.grant).toBe(f.json.access_token.split(":")[1]);
    expect(claims.grant).toMatch(/^[A-Za-z0-9:_-]{1,128}$/);
    expect(claims.scope).toBe("github/* memory/brief");
    expect(claims.cip).toBe("203.0.113.9");
    expect(claims.exp - claims.iat).toBe(60);
    expect(Math.abs(claims.iat - Date.now() / 1000)).toBeLessThan(5);
    expect(claims.jti).toBeTruthy();
    expect(b64u(new Uint8Array(0))).toBe(""); // helper sanity
  });

  it("missing, unknown and revoked tokens get 401 with a resource-metadata hint", async () => {
    const h = await harness();
    const none = await h.call(get("/mcp"));
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    expect(none.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource");

    const bad = await h.call(get("/mcp", "", { Authorization: "Bearer nope:nope:nope" }));
    expect(bad.status).toBe(401);

    const f = await fullFlow(h);
    const live = await h.call(get("/mcp", "", { Authorization: "Bearer " + f.json.access_token }));
    expect(live.status).toBe(200);
    const keys = await h.env.OAUTH_KV.list({ prefix: "token:" });
    expect(keys.keys.length).toBeGreaterThan(0);
    for (const k of keys.keys) await h.env.OAUTH_KV.delete(k.name);
    const gone = await h.call(get("/mcp", "", { Authorization: "Bearer " + f.json.access_token }));
    expect(gone.status).toBe(401);
    expect(gone.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    expect(h.origin.requests).toHaveLength(1); // only the live call reached the origin
  });

  it("refresh rotates the refresh token", async () => {
    const h = await harness();
    const f = await fullFlow(h);
    const refresh = (rt: string) =>
      h.call(post("/token", { grant_type: "refresh_token", refresh_token: rt, client_id: f.client.client_id, resource: ORIGIN + "/mcp" }));
    const r1 = await refresh(f.json.refresh_token);
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(j1.refresh_token).not.toBe(f.json.refresh_token);
    expect(j1.access_token).not.toBe(f.json.access_token);
    const use = await h.call(get("/mcp", "", { Authorization: "Bearer " + j1.access_token }));
    expect(use.status).toBe(200);
    // using the new refresh token retires the old one
    const r2 = await refresh(j1.refresh_token);
    expect(r2.status).toBe(200);
    const replay = await refresh(f.json.refresh_token);
    expect(replay.status).toBe(400);
  });
});

describe("admin and manual client", () => {
  it("creates a client_secret_post client, which works at /token and still needs PKCE", async () => {
    const h = await harness();
    // sign in as admin
    const page = await h.call(get("/admin/clients"));
    expect(page.status).toBe(200);
    const adminState = await stateOf(page);
    expect(await page.text()).toContain("Admin sign-in");
    const jar0 = cookiesOf(page);
    const cb = await h.call(get(`/auth/callback?userId=u1&secret=s1&state=${adminState}`, jar0));
    expect(cb.status).toBe(303);
    expect(cb.headers.get("Location")).toBe("/admin/clients");
    const jar = cookiesOf(cb) || jar0;
    const list = await h.call(get("/admin/clients", jar));
    const csrf = await csrfOf(list);
    expect(csrf).toBeTruthy();

    // no CSRF, no client
    expect((await h.call(post("/admin/clients/create", { name: "Gemini", redirect_uris: CB }, jar))).status).toBe(400);
    // bad scheme
    expect((await h.call(post("/admin/clients/create", { csrf, name: "G", redirect_uris: "http://evil.example/cb" }, jar))).status).toBe(400);

    const made = await h.call(post("/admin/clients/create", { csrf, name: "Gemini", redirect_uris: CB }, jar));
    expect(made.status).toBe(200);
    const html = await made.text();
    const id = html.match(/Client ID <code>([^<]+)<\/code>/)![1];
    const secret = html.match(/Client secret <code>([^<]+)<\/code>/)![1];
    expect(secret.length).toBeGreaterThan(20);
    // the secret is not shown again
    expect(await (await h.call(get("/admin/clients", jar))).text()).not.toContain(secret);

    // without PKCE: refused even though the client is confidential
    expect((await h.call(get(authorizePath(id)))).status).toBe(400);

    // with PKCE: the whole flow, token endpoint auth in the POST body
    const { verifier, challenge } = await pkce();
    const { cookie, consent } = await toConsent(h, id, challenge);
    expect(await consent.clone().text()).toContain("Gemini wants to use");
    const allow = await h.call(post("/auth/consent", { csrf: await csrfOf(consent), decision: "allow", scope: "github/*" }, cookie));
    const code = new URL(allow.headers.get("Location")!).searchParams.get("code")!;
    const bad = await h.call(post("/token", { grant_type: "authorization_code", code, redirect_uri: CB, client_id: id, client_secret: "wrong", code_verifier: verifier }));
    expect(bad.status).toBe(401);
    const tok = await h.call(post("/token", { grant_type: "authorization_code", code, redirect_uri: CB, client_id: id, client_secret: secret, code_verifier: verifier }));
    expect(tok.status).toBe(200);

    // delete it
    const del = await h.call(post("/admin/clients/delete", { csrf, client_id: id }, jar));
    expect(del.status).toBe(303);
    expect(await (await h.call(get("/admin/clients", jar))).text()).not.toContain(id);
  });

  it("an OAuth flow cookie is not an admin session", async () => {
    const h = await harness();
    const { body } = await register(h);
    const { challenge } = await pkce();
    const { cookie } = await toConsent(h, body.client_id, challenge);
    const res = await h.call(get("/admin/clients", cookie));
    expect(await res.text()).toContain("Admin sign-in");
  });
});
