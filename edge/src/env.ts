import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider into every handler's env. */
  OAUTH_PROVIDER: OAuthHelpers;
  // vars (wrangler.jsonc)
  PUBLIC_ORIGIN: string;
  EDGE_AUD: string;
  EDGE_KID: string;
  APPWRITE_ENDPOINT: string;
  APPWRITE_PROJECT_ID: string;
  ALLOWED_GITHUB_IDS: string;
  ALLOWED_GOOGLE_EMAILS?: string;
  MCP_SERVERS: string;
  ORIGIN_URL: string;
  // secrets (wrangler secret put)
  EDGE_SIGNING_KEY: string;
  /** Optional. With it the session exchange is made as an admin client and the session is deleted through /users. */
  APPWRITE_API_KEY?: string;
  /** Optional. Sent to the origin only when both are set (Cloudflare Access service token). */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

/** What the grant carries into /mcp requests (encrypted by the provider). */
export interface Props {
  sub: string;
  scope: string;
}

export const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const resourceOf = (env: Env) => `${env.PUBLIC_ORIGIN.replace(/\/$/, "")}/mcp`;
