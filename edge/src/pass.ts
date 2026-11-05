import { type Env } from "./env.ts";
import { b64u, enc, randomId } from "./util.ts";

let cached: { secret: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  if (cached?.secret === env.EDGE_SIGNING_KEY) return cached.key;
  const der = Uint8Array.from(atob(env.EDGE_SIGNING_KEY.trim()), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  cached = { secret: env.EDGE_SIGNING_KEY, key };
  return key;
}

export interface PassInput {
  sub: string;
  grant: string;
  scope: string;
  cip: string;
}

export const GRANT_RE = /^[A-Za-z0-9:_-]{1,128}$/;

/** Compact JWS (EdDSA) valid for 60 s. The contract is shared with Cammut. */
export async function signPass(env: Env, p: PassInput, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!GRANT_RE.test(p.grant)) throw new Error("bad grant id");
  const header = { alg: "EdDSA", typ: "JWT", kid: env.EDGE_KID };
  const payload = {
    iss: "cammut-edge",
    aud: env.EDGE_AUD,
    sub: p.sub,
    grant: p.grant,
    scope: p.scope,
    cip: p.cip,
    iat: now,
    exp: now + 60,
    jti: randomId(16),
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, await signingKey(env), enc.encode(input));
  return `${input}.${b64u(sig)}`;
}
