import { AuthorizationError, type AuthRequest, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { identify, signInUrl } from "./appwrite.ts";
import { type Env } from "./env.ts";
import {
  ADMIN_TTL, OAUTH_TTL, clearCookie, createFlow, csrfOk, stateOk, dropFlow, loadFlow, saveFlow, setCookie, type Flow,
} from "./flow.ts";
import { supportedScopes } from "./scopes.ts";
import { PRODUCT, adminPage, consentPage, messagePage, signInPage } from "./ui.ts";

const signIn = (env: Env, heading: string, cookie: string, state: string) =>
  signInPage(env, { github: signInUrl(env, "github", state), google: signInUrl(env, "google", state) }, heading, { "Set-Cookie": cookie });

const redirect = (to: string, status: number, cookie?: string) =>
  new Response(null, { status, headers: cookie ? { Location: to, "Set-Cookie": cookie } : { Location: to } });

const expired = (env: Env) =>
  messagePage(env, 400, "This sign-in has expired", "Go back to the app and start again.", { "Set-Cookie": clearCookie() });

// ---------- /authorize ----------

async function authorize(request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams;
  // The library only insists on PKCE for public clients. Every client needs S256 here.
  if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") {
    return messagePage(env, 400, "Request not accepted", "This app must use PKCE with the S256 method.");
  }
  let req: AuthRequest;
  try {
    req = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return e.redirectTo ? redirect(e.redirectTo, 302) : messagePage(env, 400, "Request not accepted", e.description);
    }
    throw e;
  }
  const { id, flow } = await createFlow(env, "oauth", req);
  return signIn(env, `Sign in to ${PRODUCT}`, setCookie(id, OAUTH_TTL), flow.state);
}

// ---------- Appwrite return ----------

async function callback(request: Request, env: Env): Promise<Response> {
  const f = await loadFlow(env, request);
  if (!f) return expired(env);
  const q = new URL(request.url).searchParams;
  const userId = q.get("userId");
  const secret = q.get("secret");
  if (!userId || !secret) return expired(env);
  // The state we sent to Appwrite must come back, in addition to the cookie binding.
  if (!stateOk(f.flow, q.get("state"))) {
    return messagePage(env, 400, "Request not accepted", "The sign-in did not match this browser. Start again from the app.");
  }

  // First thing, before any page: the Appwrite secret lives about 60 seconds.
  const who = await identify(env, userId, secret);
  if (who === null) {
    await dropFlow(env, f.id);
    return messagePage(env, 400, "Sign-in failed", "The sign-in could not be completed. Start again.", { "Set-Cookie": clearCookie() });
  }
  if (who === "denied") {
    await dropFlow(env, f.id);
    return messagePage(env, 403, "Not allowed", "This account is not on the list for this server.", { "Set-Cookie": clearCookie() });
  }
  f.flow.ident = who;
  const admin = f.flow.kind === "admin";
  const ttl = admin ? ADMIN_TTL : OAUTH_TTL;
  await saveFlow(env, f.id, f.flow, ttl);
  return redirect(admin ? "/admin/clients" : "/auth/consent", 303, setCookie(f.id, ttl));
}

async function failed(request: Request, env: Env): Promise<Response> {
  const f = await loadFlow(env, request);
  if (f) await dropFlow(env, f.id);
  return messagePage(env, 400, "Sign-in did not finish", "Go back to the app and start again.", { "Set-Cookie": clearCookie() });
}

// ---------- consent ----------

function offered(env: Env, req: AuthRequest): string[] {
  const supported = supportedScopes(env);
  const asked = req.scope.filter((s) => supported.includes(s));
  return asked.length ? asked : supported;
}

async function consentView(env: Env, req: AuthRequest, flow: Flow, error?: string) {
  const client = await env.OAUTH_PROVIDER.lookupClient(req.clientId);
  const u = new URL(req.redirectUri);
  const host = u.host || req.redirectUri;
  return consentPage(env, {
    appName: client?.clientName || req.clientId,
    redirectHost: host,
    loopback: ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname),
    scopes: offered(env, req).map((value) => ({ value, checked: true })),
    who: flow.ident!.label,
    csrf: flow.csrf,
    formAction: u.origin !== "null" ? u.origin : u.protocol,
    error,
  });
}

async function consent(request: Request, env: Env): Promise<Response> {
  const f = await loadFlow(env, request);
  if (!f || f.flow.kind !== "oauth" || !f.flow.ident || !f.flow.req) return expired(env);
  const req = f.flow.req;
  if (request.method === "GET") return consentView(env, req, f.flow);

  const form = await request.formData();
  if (!csrfOk(f.flow, form)) return messagePage(env, 400, "Request not accepted", "The form could not be checked. Go back and try again.");

  if (form.get("decision") !== "allow") {
    await dropFlow(env, f.id);
    return redirect(authorizationErrorRedirect(req, "access_denied"), 302, clearCookie());
  }
  const ok = offered(env, req);
  const scope = [...new Set(form.getAll("scope").map(String))].filter((s) => ok.includes(s));
  if (!scope.length) return consentView(env, req, f.flow, "Tick at least one, or press Deny.");

  const { sub, userId, label } = f.flow.ident;
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: req, // from storage, never from the form
    userId,
    metadata: { label },
    scope,
    props: { sub, scope: scope.join(" ") },
  });
  await dropFlow(env, f.id);
  return redirect(redirectTo, 302, clearCookie());
}

// ---------- /admin/clients ----------

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  const f = await loadFlow(env, request);
  if (!f || f.flow.kind !== "admin" || !f.flow.ident) {
    if (request.method !== "GET") return expired(env);
    const { id, flow } = await createFlow(env, "admin");
    return signIn(env, "Admin sign-in", setCookie(id, OAUTH_TTL), flow.state);
  }
  const page = async (extra: { created?: { id: string; secret: string; name: string }; error?: string } = {}, status = 200) => {
    const { items } = await env.OAUTH_PROVIDER.listClients({ limit: 100 });
    return adminPage(env, {
      csrf: f.flow.csrf,
      clients: items.map((c) => ({ id: c.clientId, name: c.clientName ?? "", method: c.tokenEndpointAuthMethod, redirects: c.redirectUris })),
      ...extra,
    }, status);
  };
  if (request.method === "GET" && path === "/admin/clients") return page();
  if (request.method !== "POST") return notFound();

  const form = await request.formData();
  if (!csrfOk(f.flow, form)) return messagePage(env, 400, "Request not accepted", "The form could not be checked. Go back and try again.");

  if (path === "/admin/clients/delete") {
    const id = String(form.get("client_id") ?? "");
    if (id) await env.OAUTH_PROVIDER.deleteClient(id);
    return redirect("/admin/clients", 303);
  }
  if (path === "/admin/clients/create") {
    const name = String(form.get("name") ?? "").trim().slice(0, 80);
    const uris = String(form.get("redirect_uris") ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!name || !uris.length || uris.length > 10) return page({ error: "Enter a name and one to ten redirect URIs." }, 400);
    try {
      for (const u of uris) {
        const p = new URL(u);
        const loop = ["localhost", "127.0.0.1", "[::1]"].includes(p.hostname);
        if (p.protocol !== "https:" && !(p.protocol === "http:" && loop)) throw new Error("bad scheme");
      }
      const c = await env.OAUTH_PROVIDER.createClient({
        clientName: name,
        redirectUris: uris,
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
      });
      return page({ created: { id: c.clientId, secret: c.clientSecret ?? "", name } });
    } catch {
      return page({ error: "A redirect URI is not valid. Use https addresses." }, 400);
    }
  }
  return notFound();
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const m = request.method;
    if (pathname === "/authorize" && m === "GET") return authorize(request, env);
    if (pathname === "/auth/callback" && m === "GET") return callback(request, env);
    if (pathname === "/auth/failed" && m === "GET") return failed(request, env);
    if (pathname === "/auth/consent" && (m === "GET" || m === "POST")) return consent(request, env);
    if (pathname.startsWith("/admin/clients")) return admin(request, env, pathname);
    return notFound();
  },
};
