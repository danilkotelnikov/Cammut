import { createExecutionContext, env as baseEnv } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";

export const ORIGIN = "https://mcp.example.com";
export const AW = "https://fra.cloud.appwrite.io/v1";
export const CB = "https://client.example/cb";

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
export const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface Harness {
  env: Env;
  publicKey: CryptoKey;
  aw: { calls: string[]; identities: unknown[]; tokenStatus: number; secretIn: "body" | "cookie"; keys: (string | null)[] };
  origin: { requests: { url: string; init: RequestInit }[]; reply: () => Response };
  gh: { id: number; calls: string[] };
  call: (req: Request) => Promise<Response>;
}

/** Fresh env (own signing key), Appwrite and origin mocked on global fetch. */
export async function harness(over: Partial<Env> = {}): Promise<Harness> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const env = {
    ...(baseEnv as unknown as Env),
    EDGE_SIGNING_KEY: b64((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer),
    CF_ACCESS_CLIENT_ID: "cid",
    CF_ACCESS_CLIENT_SECRET: "csecret",
    GITHUB_CLIENT_ID: undefined, // Appwrite path unless a test turns direct GitHub on
    ...over,
  } as Env;

  const aw: Harness["aw"] = {
    calls: [],
    identities: [{ provider: "github", providerUid: "1234567", providerEmail: "o@example.com" }],
    tokenStatus: 201,
    secretIn: "body",
    keys: [],
  };
  const gh: Harness["gh"] = { id: 1234567, calls: [] };
  const origin: Harness["origin"] = {
    requests: [],
    reply: () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    if (url.startsWith(AW)) {
      const path = url.slice(AW.length);
      aw.calls.push(`${method} ${path}`);
      if (path === "/account/sessions/token" && method === "POST") {
        aw.keys.push(new Headers(init.headers).get("X-Appwrite-Key"));
        if (aw.tokenStatus !== 201) return new Response("{}", { status: aw.tokenStatus });
        return aw.secretIn === "body"
          ? Response.json({ $id: "sess1", userId: "u1", secret: "SESSION-SECRET" }, { status: 201 })
          : new Response(JSON.stringify({ $id: "sess1" }), {
              status: 201,
              headers: { "Set-Cookie": "a_session_your-appwrite-project-id=SESSION-SECRET; Path=/; HttpOnly" },
            });
      }
      if (path === "/account/identities") {
        const h = new Headers(init.headers);
        if (h.get("X-Appwrite-Session") !== "SESSION-SECRET") return new Response("{}", { status: 401 });
        return Response.json({ total: aw.identities.length, identities: aw.identities });
      }
      if (path === "/account/sessions/current" && method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/users/u1/sessions/sess1" && method === "DELETE") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }
    if (url === "https://github.com/login/oauth/access_token" && method === "POST") {
      const b = JSON.parse(String(init.body));
      gh.calls.push(`token ${b.code} ${b.client_secret} ${b.redirect_uri}`);
      return b.code === "good" ? Response.json({ access_token: "GHTOKEN", token_type: "bearer" }) : Response.json({ error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") {
      gh.calls.push(`user ${new Headers(init.headers).get("Authorization")}`);
      return Response.json({ id: gh.id, login: "someone" });
    }
    if (url.startsWith("https://origin.example.com")) {
      origin.requests.push({ url, init });
      return origin.reply();
    }
    return new Response("unmocked " + url, { status: 599 });
  });

  return {
    env,
    publicKey: pair.publicKey,
    aw,
    origin,
    gh,
    call: async (req) => worker.fetch(req, env, createExecutionContext()),
  };
}

// ---------- small HTTP helpers ----------

export function cookiesOf(res: Response): string {
  return res
    .headers.getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export const get = (path: string, cookie = "", headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });

export const post = (path: string, body: Record<string, string | string[]>, cookie = "", headers: Record<string, string> = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: p,
  });
};

export async function pkce() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export async function register(h: Harness, method: "none" | "client_secret_post" = "none", ip = `198.51.100.${Math.floor(Math.random() * 250)}`) {
  const res = await h.call(
    new Request(ORIGIN + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({
        redirect_uris: [CB],
        client_name: "Test App",
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  return { res, body: (await res.json()) as { client_id: string; client_secret?: string } };
}

export function authorizePath(clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CB,
    state: "client-state",
    resource: ORIGIN + "/mcp",
    scope: "github/* memory/brief",
    ...extra,
  });
  return "/authorize?" + q;
}

export const csrfOf = async (res: Response) => ((await res.text()).match(/name="csrf" value="([^"]+)"/) ?? [])[1] ?? "";

/** The `state` the sign-in page sends to Appwrite (read from its GitHub link). */
export const stateOf = async (res: Response) => new URL(((await res.clone().text()).match(/href="([^"]*oauth2\/github[^"]*)"/) ?? [])[1].replace(/&#38;|&amp;/g, "&")).searchParams.get("state") ?? "";

/** authorize -> Appwrite callback -> consent page. Returns the cookie jar and the consent response. */
export async function toConsent(h: Harness, clientId: string, challenge: string) {
  const a = await h.call(get(authorizePath(clientId, { code_challenge: challenge, code_challenge_method: "S256" })));
  const state = await stateOf(a);
  const cb = await h.call(get(`/auth/callback?userId=u1&secret=s1&state=${state}`, cookiesOf(a)));
  const cookie = cookiesOf(cb) || cookiesOf(a);
  const consent = await h.call(get("/auth/consent", cookie));
  return { a, cb, cookie, consent };
}

/** Full flow up to an access and refresh token. */
export async function fullFlow(h: Harness, method: "none" | "client_secret_post" = "none", scopes = ["github/*", "memory/brief"]) {
  const { body: c } = await register(h, method);
  const { verifier, challenge } = await pkce();
  const { cookie, consent } = await toConsent(h, c.client_id, challenge);
  const csrf = await csrfOf(consent);
  const allow = await h.call(post("/auth/consent", { csrf, decision: "allow", scope: scopes }, cookie));
  const loc = new URL((await handoffTo(allow)) ?? "about:blank");
  const code = loc.searchParams.get("code") ?? "";
  const tok = await h.call(
    post("/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: CB,
      client_id: c.client_id,
      code_verifier: verifier,
      resource: ORIGIN + "/mcp",
      ...(c.client_secret ? { client_secret: c.client_secret } : {}),
    }),
  );
  const json = (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
  return { client: c, verifier, allow, loc, tok, json };
}

/** The URL the consent hand-off page moves on to (meta refresh and fallback link must agree). */
export async function handoffTo(res: Response): Promise<string | null> {
  const t = await res.clone().text();
  const meta = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(t)?.[1];
  const link = /<a href="([^"]+)">continue<\/a>/.exec(t)?.[1];
  if (!meta || meta !== link) return null;
  return meta.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
