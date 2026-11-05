import { type Env, list } from "./env.ts";

/** Every scope this edge can grant, in Cammut's scope strings. */
export function supportedScopes(env: Env): string[] {
  return [...list(env.MCP_SERVERS).map((s) => `${s}/*`), "memory/brief", "memory/remember"];
}

export function scopeLabel(scope: string): string {
  if (scope === "memory/brief") return "Read memory";
  if (scope === "memory/remember") return "Write memory";
  if (scope.endsWith("/*")) return `Use tools on: ${scope.slice(0, -2)}`;
  return scope;
}
