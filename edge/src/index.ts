import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { type Env, resourceOf } from "./env.ts";
import handler from "./handler.ts";
import proxy from "./proxy.ts";
import { supportedScopes } from "./scopes.ts";
import { PRODUCT } from "./ui.ts";

const REGISTRATIONS_PER_HOUR = 10;

/** Built per request so the options follow the env (scopes, origin) and the callback can reach KV. */
function provider(env: Env) {
  const origin = env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const scopes = supportedScopes(env);
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: proxy,
    defaultHandler: handler,
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    clientRegistrationEndpoint: `${origin}/register`,
    accessTokenTTL: 3600, // refresh tokens rotate by default in this library
    scopesSupported: scopes,
    requiredScopes: scopes, // published as scopes_supported in the protected-resource metadata
    resourceMetadata: { resource: resourceOf(env), resource_name: PRODUCT },
    // ponytail: KV counter is read-then-write, so a burst can overshoot a little. Fine for a registration limit.
    clientRegistrationCallback: async ({ request }) => {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const key = `edge:rl:reg:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
      const n = Number(await env.OAUTH_KV.get(key)) || 0;
      if (n >= REGISTRATIONS_PER_HOUR) {
        return { code: "access_denied", description: "Too many registrations. Try again later.", status: 429 };
      }
      await env.OAUTH_KV.put(key, String(n + 1), { expirationTtl: 3700 });
    },
  });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    // The library answers only the path-inserted form (.../oauth-protected-resource/mcp) and 404s the
    // bare one, which some clients still try. Same document for both.
    if (pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") {
      return Response.json(
        {
          resource: resourceOf(env),
          authorization_servers: [env.PUBLIC_ORIGIN.replace(/\/$/, "")],
          scopes_supported: supportedScopes(env),
          bearer_methods_supported: ["header"],
          resource_name: PRODUCT,
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    return provider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
