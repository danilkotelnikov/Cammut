import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type Env } from "./env.ts";
import { randomId, safeEqual } from "./util.ts";

/**
 * One browser's sign-in journey. The `__Host-` cookie holds only a random id (256 bits,
 * HttpOnly, Secure, SameSite=Lax); the record lives in KV. The id binds /authorize, the
 * Appwrite round trip and the consent form to one browser, and the record carries the
 * CSRF token and, after the allowlist check, the verified identity. Nothing sits in a URL.
 */
export interface Flow {
  kind: "oauth" | "admin";
  req?: AuthRequest;
  csrf: string;
  /** Sent to Appwrite as `state` and checked when it returns on the callback. */
  state: string;
  ident?: { sub: string; userId: string; label: string };
}

const COOKIE = "__Host-cammut-flow";
export const OAUTH_TTL = 600;
export const ADMIN_TTL = 3600;
const key = (id: string) => `edge:flow:${id}`;

export const setCookie = (id: string, maxAge: number) =>
  `${COOKIE}=${id}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
export const clearCookie = () => `${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

export async function createFlow(env: Env, kind: Flow["kind"], req?: AuthRequest) {
  const id = randomId(32);
  const flow: Flow = { kind, req, csrf: randomId(24), state: randomId(24) };
  await env.OAUTH_KV.put(key(id), JSON.stringify(flow), { expirationTtl: OAUTH_TTL });
  return { id, flow };
}

export function cookieId(request: Request): string | null {
  const m = (request.headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}

export async function loadFlow(env: Env, request: Request) {
  const id = cookieId(request);
  if (!id) return null;
  const flow = await env.OAUTH_KV.get<Flow>(key(id), "json");
  return flow ? { id, flow } : null;
}

export const saveFlow = (env: Env, id: string, flow: Flow, ttl: number) =>
  env.OAUTH_KV.put(key(id), JSON.stringify(flow), { expirationTtl: ttl });

export const dropFlow = (env: Env, id: string) => env.OAUTH_KV.delete(key(id));

export const stateOk = (flow: Flow, state: string | null) => !!state && safeEqual(state, flow.state);

export const csrfOk = (flow: Flow, form: FormData) => {
  const v = form.get("csrf");
  return typeof v === "string" && safeEqual(v, flow.csrf);
};
