import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Button } from "@heroui/react"
import { api, ApiError, type TokenRow } from "../api"
import { Banner } from "../components/Banner"
import { Confirm } from "../components/Dialog"
import { parseScopes, scopeProblem, tokenState } from "../format"
import { endpointFromConsole, previewConfig, tokenEnvName, type Client } from "./setupPreview"

// Two spellings of the same grants: the hooks call the REST API (memory/brief|recall|remember, see internal/memoryapi),
// agents call the MCP tools (memory/memory_*, see internal/memorymcp). A token needs both to serve both.
export const readScopes = ["memory/brief", "memory/recall", "memory/memory_projects", "memory/memory_brief", "memory/memory_recall", "memory/memory_history"]
export const writeScopes = ["memory/remember", "memory/memory_remember", "memory/memory_handoff", "memory/memory_confirm"]
const expiries = [["30 days", 24 * 30], ["90 days", 24 * 90], ["1 year", 24 * 365], ["never", 0]] as const
const labelRe = /^[A-Za-z0-9._-]{1,40}$/
const clients: { key: Client; label: string; file: string; reference: string; note: string }[] = [
  {
    key: "claude", label: "Claude Code", file: ".mcp.json (project scope)",
    reference: "https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json",
    note: "Requires a Claude Code version supporting remote HTTP servers and ${VAR} expansion in .mcp.json headers. Check claude --version and claude mcp get cammut; approve the project server when prompted.",
  },
  {
    key: "codex", label: "Codex CLI", file: "~/.codex/config.toml (or a trusted project's .codex/config.toml)",
    reference: "https://developers.openai.com/codex/mcp",
    note: "Requires a Codex CLI version supporting Streamable HTTP and bearer_token_env_var. Check codex --version, then /mcp; project config is loaded only for a trusted project.",
  },
  {
    key: "generic", label: "Warp / generic MCP", file: "Your client's MCP settings",
    reference: "https://modelcontextprotocol.io/specification/",
    note: "Requires a client that supports Streamable HTTP MCP with a bearer Authorization header. Warp: see adapters/warp/mcp.json.example and AGENTS.memory.md in the repo. Check the client's own version and docs; there is no universal lifecycle-hook schema.",
  },
]

const errorText = (e: unknown) => e instanceof ApiError || e instanceof Error ? e.message : "Unexpected setup error."

export function AgentSetup() {
  const [client, setClient] = useState<Client>("claude")
  const [endpoint, setEndpoint] = useState(() => endpointFromConsole(window.location.origin))
  const endpointTouched = useRef(false)
  const [existing, setExisting] = useState("{}")
  const [rows, setRows] = useState<TokenRow[] | null>(null)
  const [label, setLabel] = useState("")
  const [writes, setWrites] = useState(false)
  const [extra, setExtra] = useState("")
  const [hours, setHours] = useState<number>(24 * 30)
  const [reveal, setReveal] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<TokenRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const selected = clients.find((x) => x.key === client)!
  const scopes = useMemo(() => [...readScopes, ...(writes ? writeScopes : []), ...parseScopes(extra)], [writes, extra])

  const load = useCallback(async () => {
    try {
      setRows(await api.tokens.list())
    } catch (e) {
      setError(`Cannot list credentials: ${errorText(e)}`)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    // On the private tunnel the page origin is loopback; the server tells us the public origin it was started with.
    api.me().then((m) => { if (!endpointTouched.current) setEndpoint(endpointFromConsole(window.location.origin, m.site_origin)) }, () => {})
  }, [])

  const preview = useMemo(() => {
    try {
      return { result: previewConfig(client, endpoint, existing), problem: "" }
    } catch (e) {
      return { result: null, problem: errorText(e) }
    }
  }, [client, endpoint, existing])

  function selectClient(value: Client) {
    setClient(value)
    setExisting(value === "codex" || value === "generic" ? "" : "{}")
    setReveal(null) // never carry a plaintext credential to another client's setup
    setError("")
    setNotice("")
  }

  async function createToken(e: FormEvent) {
    e.preventDefault()
    setError("")
    setNotice("")
    if (!labelRe.test(label)) return setError("Token label must be 1–40 letters, digits, . _ or -.")
    const bad = scopeProblem(scopes)
    if (bad) return setError(bad)
    setBusy(true)
    try {
      const created = await api.tokens.create({ label, scopes: [...new Set(scopes)], ...(hours > 0 ? { expires_in_hours: hours } : {}) })
      setReveal(created.token)
      setLabel("")
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    if (!revoking) return
    setBusy(true)
    try {
      await api.tokens.revoke(revoking.label)
      setRows((current) => current?.map((t) => t.id === revoking.id ? { ...t, revoked: true } : t) ?? null)
      setNotice(`${revoking.label} revoked on the server. Remove only its Cammut client entry; other servers and hooks remain untouched.`)
      setRevoking(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-[.18em] opacity-60">Connection desk / 01</p>
        <h1 className="text-2xl font-semibold tracking-tight">Agent setup</h1>
        <p className="max-w-3xl text-sm opacity-70">Connect one client at a time. A working MCP connection grants tools; it does not install capture hooks or prove memory restoration.</p>
      </header>
      {error ? <Banner title={error} /> : null}
      {notice ? <Banner status="success" title={notice} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Client capabilities">
        {[
          ["Tools connected:", "unverified — run a read-only call"],
          ["Capture:", "unverified — hooks are installed by the adapters, not here"],
          ["Recall injected:", "unverified — use manual brief"],
          ["Compaction:", "unverified — no real-client check"],
        ].map(([name, state]) => (
          <div key={name} className="rounded-lg border border-current/20 p-3 text-sm">
            <p className="font-medium">{name} <span className="font-normal opacity-70">{state}</span></p>
          </div>
        ))}
      </div>
      <Banner status="warning" title="MCP access alone is not automatic memory.">
        Explicit notes and handoffs belong to Cammut; inferred long-term extraction belongs to Hindsight. The Claude Code and Codex adapters inject the project brief at session start; Warp has no hooks, so it relies on the instructions in adapters/warp/AGENTS.memory.md. Until a real run of each client is checked, ask for the project brief when resuming.
      </Banner>
      <section className="flex flex-col gap-4 rounded-lg border border-current/20 p-4" aria-label="Client connection">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choose client">
          {clients.map((item) => (
            <button key={item.key} type="button" aria-pressed={client === item.key} onClick={() => selectClient(item.key)}
              className={"rounded-md border px-3 py-2 text-sm " + (client === item.key ? "border-current bg-[var(--foreground)] text-[var(--background)]" : "border-current/30 hover:border-current")}>
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-sm">{selected.note}{" "}
          <a className="underline underline-offset-2" href={selected.reference} target="_blank" rel="noreferrer noopener">Official configuration reference</a>
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span>MCP endpoint (not the private console listener)</span>
          <input value={endpoint} onChange={(e) => { endpointTouched.current = true; setEndpoint(e.target.value) }} spellCheck={false} autoComplete="off"
            className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm" />
        </label>
        <p className="text-xs opacity-70">
          The private SSH-tunnel console on port 7422 does not serve /mcp. Use the public HTTPS endpoint, or a separately verified MCP tunnel to port 7421.
        </p>
        <div className="border-t border-current/20 pt-4">
          <h2 className="font-semibold">1 · Create a credential for {selected.label}</h2>
          <p className="text-sm opacity-70">Default: read-only memory (brief, recall, projects) for both the hooks and the MCP tools. Optional writes and additional scopes must be chosen explicitly. Scope controls tools, not project isolation.</p>
          <form className="mt-3 grid gap-3" onSubmit={(e) => void createToken(e)}>
            <label className="flex flex-col gap-1 text-sm">
              <span>Token label</span>
              <input aria-label="Token label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40}
                autoComplete="off" placeholder={`${client}-owner`} className="rounded-lg border border-current/30 bg-transparent px-3 py-2" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={writes} onChange={(e) => setWrites(e.target.checked)} />
              Permit explicit note and handoff writes
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Additional scopes (optional)</span>
              <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} spellCheck={false}
                placeholder="server/one_tool" className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm" />
              <span className="text-xs opacity-60">One server/tool per scope, separated by spaces or commas. A wildcard may permit writes; inspect the actual tool before granting it.</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Token expires after</span>
              <select aria-label="Token expiry" value={hours} onChange={(e) => setHours(Number(e.target.value))}
                className="rounded-lg border border-current/30 bg-transparent px-3 py-2">
                {expiries.map(([name, h]) => <option key={name} value={h}>{name}</option>)}
              </select>
              <span className="text-xs opacity-60">After that date hooks and tools get 403 and memory silently stops; create a new token before then.</span>
            </label>
            <p className="mono break-all text-xs opacity-70">Grant: {scopes.join(", ")}</p>
            <div><Button type="submit" isPending={busy || reveal !== null}>Create scoped token</Button></div>
          </form>
          {reveal !== null ? (
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-600/60 p-3" aria-label="One-time token">
              <strong className="text-sm">One-time credential — save privately now.</strong>
              <code className="mono break-all text-sm" data-testid="setup-token-plaintext">{reveal}</code>
              <p className="text-xs opacity-70">Set {tokenEnvName(client)} in the client process environment. Do not paste the token into a config file, URL, command history or ticket. Cammut stores only a hash.</p>
              <div><Button size="sm" onPress={() => setReveal(null)}>I saved the token</Button></div>
            </div>
          ) : null}
        </div>
        <div className="border-t border-current/20 pt-4">
          <h2 className="font-semibold">2 · Preview, then install manually</h2>
          <p className="text-sm opacity-70">Target: {selected.file}. Back up the original file yourself. This page only calculates a local preview; it reads no file and writes no hooks or config. Avoid pasting an existing file containing secrets.</p>
          {preview.problem ? <Banner title={preview.problem} /> : null}
          {client === "generic" ? (
            <p className="mt-2 text-sm">Configure Streamable HTTP to the endpoint above and an <code className="mono">Authorization: Bearer &lt;token from {tokenEnvName(client)}&gt;</code> header using your client's supported secure secret mechanism. No generic config or lifecycle hook can be installed safely.</p>
          ) : (
            <>
              <label className="mt-3 flex flex-col gap-1 text-sm">
                <span>Existing config (local preview only)</span>
                <textarea value={existing} onChange={(e) => setExisting(e.target.value)} rows={5} spellCheck={false}
                  className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-xs" />
              </label>
              {preview.result ? (
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-medium">Install preview</h3>
                    <pre aria-label="Install preview" className="mono mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-current/20 p-3 text-xs">{preview.result.install}</pre>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">Uninstall preview (original input)</h3>
                    <pre aria-label="Uninstall preview" className="mono mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-current/20 p-3 text-xs">{preview.result.uninstall || "(empty file)"}</pre>
                  </div>
                </div>
              ) : null}
              <p className="mt-2 text-xs opacity-70">Install only after reviewing a diff and preserving a backup. Codex previews append a block and do not validate the entire TOML document; validate it with your installed client before use. Uninstall later by removing just the <code className="mono">cammut</code> MCP entry (for Codex, the marked block); do not restore a stale whole-file preview after unrelated edits. Revoke its token separately.</p>
            </>
          )}
        </div>
        <div className="border-t border-current/20 pt-4 text-sm">
          <h2 className="font-semibold">3 · Verify tools, then memory separately</h2>
          <p className="mt-1">In the client, inspect its MCP connection and call the read-only <code className="mono">cammut_call</code> tool with <code className="mono">{'{"tool":"memory/memory_projects","arguments":{}}'}</code>. A successful response verifies that one read-only tool call, not capture or recall injection.</p>
          <p className="mt-1 opacity-70">Manual continuation: call <code className="mono">cammut_call</code> for <code className="mono">memory/memory_brief</code> with the explicit project argument and check that the brief matches the current project before acting.</p>
        </div>
      </section>
      <section className="flex flex-col gap-2 rounded-lg border border-current/20 p-4">
        <h2 className="font-semibold">Credentials & revocation</h2>
        {rows === null ? <p className="text-sm opacity-70">Checking credentials…</p> : rows.length === 0 ? <p className="text-sm opacity-70">No client tokens yet.</p> : rows.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-current/10 py-2 text-sm">
            <div><strong>{t.label}</strong> · {tokenState(t)} · <span className="mono text-xs">{t.scopes.join(", ") || "no scopes"}</span></div>
            {tokenState(t) !== "revoked" ? <Button size="sm" variant="danger" onPress={() => setRevoking(t)}>Revoke {t.label}</Button> : null}
          </div>
        ))}
      </section>
      <Confirm open={revoking !== null} title="Revoke client token"
        body={revoking ? `Revoke ${revoking.label}? The client loses access immediately. Other tokens, MCP servers and hooks remain unchanged.` : ""}
        confirmLabel="Confirm revoke" danger busy={busy} onClose={() => setRevoking(null)} onConfirm={() => void revoke()} />
    </div>
  )
}
