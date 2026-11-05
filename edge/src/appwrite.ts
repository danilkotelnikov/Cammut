import { type Env, list } from "./env.ts";

export type Provider = "github" | "google";

export interface Identity {
  sub: string; // "gh:<id>" or "google:<email>"
  userId: string; // library-safe id (the provider forbids ':')
  label: string;
}

const base = (env: Env) => env.APPWRITE_ENDPOINT.replace(/\/$/, "");

export function signInUrl(env: Env, provider: Provider, state: string): string {
  const q = new URLSearchParams({
    project: env.APPWRITE_PROJECT_ID,
    success: `${env.PUBLIC_ORIGIN}/auth/callback`,
    failure: `${env.PUBLIC_ORIGIN}/auth/failed`,
    state,
  });
  if (provider === "github") q.append("scopes[]", "read:user");
  return `${base(env)}/account/tokens/oauth2/${provider}?${q}`;
}

function sessionFromCookies(res: Response, project: string): string | undefined {
  for (const c of res.headers.getSetCookie()) {
    const m = c.match(new RegExp(`^a_session_${project}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
}

interface Ident {
  provider: string;
  providerUid?: string;
  providerEmail?: string;
}

/**
 * Called first thing on the callback: the Appwrite secret lives about 60 s.
 * Exchanges it, reads the identities, deletes the session (only the identity is needed).
 * null = Appwrite refused or failed; "denied" = signed in but not on the allowlist.
 */
export async function identify(env: Env, userId: string, secret: string): Promise<Identity | "denied" | null> {
  let res: Response;
  try {
    res = await fetch(`${base(env)}/account/sessions/token`, {
      method: "POST",
      headers: {
        "X-Appwrite-Project": env.APPWRITE_PROJECT_ID,
        "Content-Type": "application/json",
        // With a key, Appwrite returns the plain session secret in the JSON body.
        ...(env.APPWRITE_API_KEY ? { "X-Appwrite-Key": env.APPWRITE_API_KEY } : {}),
      },
      body: JSON.stringify({ userId, secret }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const session = (await res.json().catch(() => ({}))) as { secret?: string; $id?: string; userId?: string };
  const token = session.secret || sessionFromCookies(res, env.APPWRITE_PROJECT_ID);
  if (!token) return null;

  const auth = {
    "X-Appwrite-Project": env.APPWRITE_PROJECT_ID,
    "X-Appwrite-Session": token,
    Cookie: `a_session_${env.APPWRITE_PROJECT_ID}=${token}`,
  };
  try {
    const r = await fetch(`${base(env)}/account/identities`, { headers: auth });
    if (!r.ok) return null;
    const body = (await r.json()) as { identities?: Ident[] };
    return match(env, body.identities ?? []);
  } catch {
    return null;
  } finally {
    const del =
      env.APPWRITE_API_KEY && session.$id
        ? fetch(`${base(env)}/users/${encodeURIComponent(session.userId || userId)}/sessions/${encodeURIComponent(session.$id)}`, {
            method: "DELETE",
            headers: { "X-Appwrite-Project": env.APPWRITE_PROJECT_ID, "X-Appwrite-Key": env.APPWRITE_API_KEY },
          })
        : fetch(`${base(env)}/account/sessions/current`, { method: "DELETE", headers: auth });
    await del.catch(() => {});
  }
}

function match(env: Env, ids: Ident[]): Identity | "denied" {
  const gh = list(env.ALLOWED_GITHUB_IDS);
  const emails = list(env.ALLOWED_GOOGLE_EMAILS).map((e) => e.toLowerCase());
  for (const i of ids) {
    if (i.provider === "github" && i.providerUid && gh.includes(String(i.providerUid))) {
      return { sub: `gh:${i.providerUid}`, userId: `gh_${i.providerUid}`, label: `GitHub user ${i.providerUid}` };
    }
  }
  for (const i of ids) {
    const e = i.providerEmail?.toLowerCase();
    if (i.provider === "google" && e && emails.includes(e)) {
      return { sub: `google:${e}`, userId: `google_${encodeURIComponent(e)}`, label: e };
    }
  }
  return "denied";
}
