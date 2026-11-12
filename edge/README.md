# Cammut edge (staging Worker)

A Cloudflare Worker that is the OAuth front door for AI apps (Claude, ChatGPT, Gemini, Composio). It runs as `cammut-edge-staging` on your own domain (this README uses `mcp.example.com`).

What it does:

1. Acts as OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider` 1.2.4, KV storage): discovery, dynamic client registration (10 per IP per hour), `/authorize`, `/token`, refresh-token rotation, access tokens of 1 hour.
2. Requires PKCE `S256` for every client, public or confidential.
3. Signs the owner in through Appwrite (GitHub first, Google second), checks the allowlist, shows a consent page with the scopes as checkboxes.
4. Forwards `/mcp` to the Cammut origin through the Cloudflare Tunnel with the Access service token and a 60-second Ed25519 pass (`Authorization: Bearer <pass>`). Bodies are streamed, not buffered.
5. `/admin/clients` (owner only): list clients, create a manual client for Gemini (`client_secret_post`, secret shown once), delete a client.

Nothing here is deployed by the repository. No command in this folder logs in or deploys on its own.

## Pass contract (shared with Cammut)

Compact JWS, `EdDSA`, header `{"alg":"EdDSA","typ":"JWT","kid":EDGE_KID}`, payload
`{iss:"cammut-edge", aud:EDGE_AUD, sub, grant, scope, cip, iat, exp:iat+60, jti}`.
`sub` is `gh:<numeric id>` or `google:<email>`; `grant` is the provider's grant id (16 letters or digits); `scope` is the granted scopes joined by spaces; `cip` is `CF-Connecting-IP` or empty.

Scopes: `<server>/*` for every name in `MCP_SERVERS` ("Use tools on: <server>"), `memory/brief` ("Read memory"), `memory/remember` ("Write memory").

## Configuration

`wrangler.jsonc` vars:

| Var | Meaning |
|---|---|
| `PUBLIC_ORIGIN` | `https://mcp.example.com`. The resource is `PUBLIC_ORIGIN + /mcp`, exactly. |
| `EDGE_AUD`, `EDGE_KID` | `aud` claim and `kid` header of the pass. |
| `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` | Regional Appwrite endpoint and project. |
| `ALLOWED_GITHUB_IDS` | Comma list of GitHub numeric ids that may sign in. |
| `ALLOWED_GOOGLE_EMAILS` | Comma list of Google emails that may sign in (empty = none). |
| `MCP_SERVERS` | Comma list of server names that become `<name>/*` scopes. |
| `ORIGIN_URL` | Cammut origin behind the tunnel. |

Secrets (set with `wrangler secret put`, never in the repo):

| Secret | Meaning |
|---|---|
| `EDGE_SIGNING_KEY` | Ed25519 private key, PKCS8, base64 (made by `scripts/keygen.mjs`). |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token for the tunnel hostname. |
| `APPWRITE_API_KEY` | Optional, recommended. Appwrite API key with scopes `sessions.write` and `users.write` only (see below). Never logged. |

KV binding: `OAUTH_KV` (the id in `wrangler.jsonc` is a placeholder).

## Appwrite setup it expects

- Project `your-appwrite-project-id`, GitHub and Google OAuth providers enabled.
- `mcp.example.com` added as a Web platform (otherwise Appwrite refuses the success URL).
- Sign-in redirect (token flow), as a browser link:
  `{APPWRITE_ENDPOINT}/account/tokens/oauth2/{github|google}?project={APPWRITE_PROJECT_ID}&success=https://mcp.example.com/auth/callback&failure=https://mcp.example.com/auth/failed&state={random per flow}` plus `scopes[]=read:user` for GitHub only (URL-encoded).
- Appwrite returns `userId`, `secret` and the same `state` on the success URL. The callback first checks `state` against the flow record (400 if missing or different, before any Appwrite call), in addition to the `__Host-` cookie.
- Then it exchanges at once (`POST /account/sessions/token`; the secret lives about 60 seconds), reads `GET /account/identities` with the session, and deletes the session.
- With `APPWRITE_API_KEY` set: the exchange carries `X-Appwrite-Key`, the plain session secret is taken from the JSON `secret`, and the session is deleted with `DELETE /users/{userId}/sessions/{sessionId}` (key). Without it: the secret is taken from the `a_session_<project>` Set-Cookie and the session is deleted with `DELETE /account/sessions/current`.

## Local checks

```sh
cd edge
npm install
npm test                        # vitest in the Workers runtime (offline) + node test of keygen
npm run typecheck               # tsc --noEmit
npx wrangler deploy --dry-run --outdir dist   # bundles; needs no login
```

Tests mock Appwrite and the origin on `fetch`; no network.

## Deploy steps (owner)

1. `cd edge && npm install`, then `npx wrangler login`.
2. Create the KV namespace: `npx wrangler kv namespace create OAUTH_KV`. Paste the printed id into `kv_namespaces[0].id` in `wrangler.jsonc` in place of `REPLACE_WITH_KV_ID`.
3. Make the signing key: `node scripts/keygen.mjs`. It writes `edge-signing-key.txt` (git-ignored) and prints two lines. Give the first line (`edge-1=...`) to Cammut as its edge public key flag. Run the second line (`npx wrangler secret put EDGE_SIGNING_KEY < edge-signing-key.txt`). Then move the key file somewhere safe.
4. In the Appwrite console (project `your-appwrite-project-id`) create an API key with exactly these scopes: `sessions.write` (the token exchange) and `users.write` (delete the session through `/users/{id}/sessions/{id}`). Nothing else; identities are read with the user's own session. Then `npx wrangler secret put APPWRITE_API_KEY`.
5. Put the Access service token in: `npx wrangler secret put CF_ACCESS_CLIENT_ID` and `npx wrangler secret put CF_ACCESS_CLIENT_SECRET` (paste the values when asked).
6. Check `vars` in `wrangler.jsonc` (allowed ids, `MCP_SERVERS`, `ORIGIN_URL`), then `npx wrangler deploy`. The custom domain `mcp.example.com` must belong to a zone in your Cloudflare account.

After deploy, open `https://mcp.example.com/admin/clients`, sign in, and create the Gemini client there.
