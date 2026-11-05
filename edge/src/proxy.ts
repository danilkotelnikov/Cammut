import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { type Env, type Props } from "./env.ts";
import { signPass } from "./pass.ts";

type Ctx = OAuthResourceContext<Props> & { props: Props };

/** Tokens look like `userId:grantId:secret`; userId never contains `:`. */
const grantOf = (token: string) => token.split(":")[1] ?? "";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { props, auth } = ctx as unknown as Ctx;
    const cip = request.headers.get("CF-Connecting-IP") ?? "";

    let pass: string;
    try {
      pass = await signPass(env, { sub: props.sub, grant: grantOf(auth.token), scope: props.scope, cip });
    } catch {
      return Response.json({ error: "server_error" }, { status: 500 });
    }

    const src = new URL(request.url);
    const target = new URL(env.ORIGIN_URL.replace(/\/$/, "") + src.pathname + src.search);

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      const l = k.toLowerCase();
      if (l === "authorization" || l === "cookie" || l === "host" || l.startsWith("cf-") || l.startsWith("x-forwarded-")) continue;
      headers.set(k, v);
    }
    if (cip) headers.set("X-Forwarded-For", cip);
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
    }
    headers.set("Authorization", `Bearer ${pass}`);

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    try {
      // The body stream goes straight through; nothing is buffered.
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
        redirect: "manual",
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
      return new Response(upstream.body, upstream);
    } catch {
      return Response.json({ error: "bad_gateway" }, { status: 502 });
    }
  },
};
