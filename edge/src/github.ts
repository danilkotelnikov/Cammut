import { type Env, list } from "./env.ts";
import type { Identity } from "./appwrite.ts";

/**
 * Direct GitHub sign-in (OAuth App), used when GITHUB_CLIENT_ID is set. It replaces the Appwrite hop,
 * which refuses some regions ("Project is not accessible in this region").
 */
export const githubCallback = (env: Env) => `${env.PUBLIC_ORIGIN.replace(/\/$/, "")}/auth/github/callback`;

export function githubSignInUrl(env: Env, state: string): string {
  const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: githubCallback(env), state, scope: "", allow_signup: "false" });
  return `https://github.com/login/oauth/authorize?${q}`;
}

/** null = GitHub refused or failed; "denied" = signed in but not on the allowlist. */
export async function githubIdentify(env: Env, code: string): Promise<Identity | "denied" | null> {
  try {
    const t = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "cammut-edge" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: githubCallback(env) }),
    });
    const tok = ((await t.json().catch(() => ({}))) as { access_token?: string }).access_token;
    if (!t.ok || !tok) return null;
    const u = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "cammut-edge" },
    });
    const id = ((await u.json().catch(() => ({}))) as { id?: number }).id;
    if (!u.ok || !id) return null;
    if (!list(env.ALLOWED_GITHUB_IDS).includes(String(id))) return "denied";
    return { sub: `gh:${id}`, userId: `gh_${id}`, label: `GitHub user ${id}` };
  } catch {
    return null;
  }
}
