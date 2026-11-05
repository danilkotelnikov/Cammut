export class ApiError extends Error {
  status: number
  retryAfter?: number
  constructor(status: number, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

export type Upstream = {
  name: string
  url: string
  bearer_env: string
  bearer_secret: string
  auth_header: string
  secret_set: boolean
  enabled: boolean
  status: "ok" | "unreachable" | "checking" | "disabled"
  tools: number
  last_error: string
}
export type TestResult = { ok: boolean; tools: string[]; millis: number; error: string }
export type TokenRow = {
  id: number
  label: string
  scopes: string[]
  revoked: boolean
  created_at: string | null
  last_used_at: string | null
  expires_at: string | null
  profile: string
}
export type CreatedToken = { label: string; scopes: string[]; expires_at: string | null; token: string }
export type SecretPolicy = { purpose: string; hosts: string[] }
export type SecretMeta = { name: string; updated_at: string | null; purpose: string; hosts: string[] }
export type OAuthGrant = { id: number; created_at: string | null; last_used_at: string | null }
export type OAuthClient = { id: string; name: string; redirect_uris: string[]; scopes: string[]; created_at: string | null; grants: OAuthGrant[] }
export type OAuthRequest = { client_name: string; scopes: string[]; redirect_host: string }
export type AuditRow = {
  ts: string | null
  token_id: number
  upstream: string
  tool: string
  ok: boolean
  ms: number
  note: string
  ip: string
  actor: string
}
export type MemProject = { name: string; notes: number; last_activity: string | null; brief_version: number }
export type MemNote = {
  id: string
  ref?: string
  project: string
  kind: string
  key?: string
  epistemic: "observed" | "inferred" | "speculative"
  title: string
  body: string
  tags: string[]
  status: string
  importance: number
  source_agent: string
  created_at: string
  updated_at: string
}
export type MemReview = { id: number; project: string; cosine: number; note: MemNote; candidate: MemNote }
export type MemQuery = { project?: string; kind?: string; status?: string; q?: string; limit?: number }
export type MemBrief = {
  project: string
  version: number
  generator: string
  stale: boolean
  tier: string
  tokens: number
  generated_at: string
  body: string
  accounting: { active: number; full: number; gist: number; index: number; paged: number }
}
export type MemDelivery = { agent: string; last_session: string; at: string; brief_version: number; delivered: string[]; not_delivered: string[] }
export type MemStatus = {
  projects: number
  notes: number
  briefs: number
  queue: number
  failures_24h: number
  last_ingest: string
  last_consolidation: string
  delivery?: MemDelivery
}
export type ArchiveAlerts = { segments: number; recipient_changes: number; replica_last_run_at: string | null; replica_stale: boolean; unreplicated: number }
export type AuditQuery = { upstream?: string; tool?: string; ok?: "" | "true" | "false"; token?: string; limit?: number; offset?: number }

let onUnauthorized: () => void = () => {}
export function setOnUnauthorized(fn: () => void): void {
  onUnauthorized = fn
}

const isLogin = (path: string) => path === "/login" || path === "/login/github"

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "cammut" }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  let res: Response
  try {
    res = await fetch("/api/v1" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    })
  } catch {
    throw new ApiError(0, "Could not reach the server.")
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!res.ok) {
    if (res.status === 401 && !isLogin(path)) onUnauthorized()
    const msg = (data as { error?: string } | undefined)?.error
    const retry = Number(res.headers.get("Retry-After")) || undefined
    throw new ApiError(res.status, msg || `Request failed (${res.status}).`, retry)
  }
  return data as T
}

const enc = encodeURIComponent

export const api = {
  methods: () => request<{ password: boolean; github: boolean }>("GET", "/auth/methods"),
  me: () => request<{ username: string; github_linked: boolean; site_origin: string }>("GET", "/me"),
  login: (username: string, password: string, code: string) => request<{ ok: boolean }>("POST", "/login", { username, password, code }),
  loginGithub: (code: string) => request<{ ok: boolean }>("POST", "/login/github", { code }),
  logout: () => request<{ ok: boolean }>("POST", "/logout"),

  upstreams: {
    list: () => request<Upstream[]>("GET", "/upstreams"),
    add: (u: { name: string; url: string; bearer_secret?: string; auth_header?: string; enabled?: boolean }) => request<{ name: string }>("POST", "/upstreams", u),
    patch: (name: string, p: { url?: string; bearer_secret?: string; auth_header?: string; enabled?: boolean }) => request<void>("PATCH", `/upstreams/${enc(name)}`, p),
    remove: (name: string) => request<void>("DELETE", `/upstreams/${enc(name)}`),
    test: (name: string) => request<TestResult>("POST", `/upstreams/${enc(name)}/test`),
  },
  tokens: {
    list: () => request<TokenRow[]>("GET", "/tokens"),
    create: (t: { label: string; scopes: string[]; expires_in_hours?: number }) => request<CreatedToken>("POST", "/tokens", t),
    setScopes: (label: string, scopes: string[]) => request<void>("PATCH", `/tokens/${enc(label)}`, { scopes }),
    revoke: (label: string) => request<void>("DELETE", `/tokens/${enc(label)}`),
  },
  oauth: {
    clients: () => request<OAuthClient[]>("GET", "/oauth/clients"),
    create: (c: { name: string; redirect_uris: string[]; scopes: string[] }) =>
      request<{ client: OAuthClient; client_id: string; client_secret: string }>("POST", "/oauth/clients", c),
    setRedirects: (id: string, redirect_uris: string[]) => request<void>("PATCH", `/oauth/clients/${enc(id)}`, { redirect_uris }),
    remove: (id: string) => request<void>("DELETE", `/oauth/clients/${enc(id)}`),
    removeGrant: (id: number) => request<void>("DELETE", `/oauth/grants/${id}`),
    request: (id: string) => request<OAuthRequest>("GET", `/oauth/requests/${enc(id)}`),
    approve: (id: string) => request<{ redirect: string }>("POST", `/oauth/requests/${enc(id)}/approve`, {}),
    deny: (id: string) => request<{ redirect: string }>("POST", `/oauth/requests/${enc(id)}/deny`, {}),
  },
  secrets: {
    list: () => request<SecretMeta[]>("GET", "/secrets"),
    put: (name: string, value: string, policy?: SecretPolicy) => request<void>("PUT", `/secrets/${enc(name)}`, { value, ...policy }),
    setPolicy: (name: string, policy: SecretPolicy, confirm: string) => request<void>("PUT", `/secrets/${enc(name)}/policy`, { ...policy, confirm }),
    remove: (name: string) => request<void>("DELETE", `/secrets/${enc(name)}`),
  },
  memory: {
    projects: () => request<MemProject[]>("GET", "/memory/projects"),
    notes: (q: MemQuery) => {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v))
      const s = p.toString()
      return request<MemNote[]>("GET", "/memory/notes" + (s ? "?" + s : ""))
    },
    brief: (project: string, tier?: "core" | "full") => request<MemBrief>("GET", `/memory/brief/${enc(project)}` + (tier ? `?tier=${tier}` : "")),
    status: (project?: string) => request<MemStatus>("GET", "/memory/status" + (project ? `?project=${enc(project)}` : "")),
    retract: (id: string) => request<void>("PATCH", `/memory/notes/${enc(id)}`, { status: "retracted" }),
    confirm: (id: string, epistemic: "inferred" | "observed") => request<MemNote>("POST", `/memory/notes/${enc(id)}/confirm`, { epistemic }),
    review: (project?: string) => request<MemReview[]>("GET", "/memory/review" + (project ? `?project=${enc(project)}` : "")),
    resolveReview: (id: number, action: "apply" | "dismiss") => request<void>("POST", `/memory/review/${id}/${action}`),
    history: (project: string, key: string) => request<MemNote[]>("GET", `/memory/history?project=${enc(project)}&key=${enc(key)}`),
  },
  archiveAlerts: () => request<ArchiveAlerts>("GET", "/archive/alerts"),
  audit: (q: AuditQuery) => {
    const p = new URLSearchParams()
    if (q.upstream) p.set("upstream", q.upstream)
    if (q.tool) p.set("tool", q.tool)
    if (q.ok) p.set("ok", q.ok)
    if (q.token) p.set("token", q.token)
    if (q.limit) p.set("limit", String(q.limit))
    if (q.offset) p.set("offset", String(q.offset))
    const s = p.toString()
    return request<AuditRow[]>("GET", "/audit" + (s ? "?" + s : ""))
  },
}
