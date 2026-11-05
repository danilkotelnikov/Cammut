import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Button, Chip, Input, Label, Switch, Table, TextField } from "@heroui/react"
import { api, ApiError, type Upstream } from "../api"
import { secretNameFor } from "../format"
import { Banner, type BannerStatus } from "../components/Banner"
import { Confirm, Dialog } from "../components/Dialog"

const presets = [
  { label: "GitHub", name: "github", url: "https://api.githubcopilot.com/mcp/", secret: "GITHUB_PAT", header: "" },
  // Composio gives each MCP server its own address (…/v3/mcp/<server id>?user_id=…); finish it from the Composio dashboard.
  { label: "Composio", name: "composio", url: "https://backend.composio.dev/v3/mcp/", secret: "COMPOSIO_API_KEY", header: "x-api-key" },
]

const headerRe = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

const nameRe = /^[a-z0-9][a-z0-9-]{0,31}$/
const secretRe = /^[A-Z_][A-Z0-9_]{0,63}$/

// A secret typed here may only ever be sent to the host of the server it belongs to; the host is fixed at creation.
const safeHost = (raw: string) => {
  try {
    return new URL(raw).hostname
  } catch {
    return ""
  }
}
const bearerPolicy = (rawUrl: string) => {
  const h = safeHost(rawUrl)
  return h ? { purpose: "mcp-upstream-bearer", hosts: [h] } : undefined
}

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.")

function StatusChip({ u }: { u: Upstream }) {
  const map = {
    ok: { color: "success", text: "ok" },
    unreachable: { color: "danger", text: "unreachable" },
    checking: { color: "warning", text: "checking…" },
    disabled: { color: "default", text: "disabled" },
  } as const
  const s = map[u.status]
  return (
    <Chip color={s.color} variant="soft" size="sm">
      {s.text}
    </Chip>
  )
}

function AddServer({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [secretName, setSecretName] = useState("")
  const [secretValue, setSecretValue] = useState("")
  const [header, setHeader] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // The component outlives the dialog, so a typed secret would survive a cancel and come back on reopen.
  useEffect(() => {
    if (!open) {
      setName("")
      setUrl("")
      setHeader("")
      setSecretName("")
      setSecretValue("")
      setError("")
    }
  }, [open])

  function usePreset(p: (typeof presets)[number]) {
    setName(p.name)
    setUrl(p.url)
    setSecretName(p.secret)
    setHeader(p.header)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError("")
    if (!nameRe.test(name)) return setError("Name: lowercase letters, digits and dashes, starting with a letter or digit (max 32).")
    if (!/^https?:\/\//.test(url)) return setError("Address must start with http:// or https://")
    if (secretName && !secretRe.test(secretName)) return setError("Secret name looks like GITHUB_PAT: capital letters, digits, underscore.")
    if (secretValue && !secretName) return setError("Give the secret a name to store the value under.")
    if (header && !headerRe.test(header)) return setError("Key header: letters, digits and dashes, for example x-api-key.")
    setBusy(true)
    try {
      if (secretValue) {
        const policy = bearerPolicy(url)
        if (!policy) return setError("The address is not a valid URL.")
        await api.secrets.put(secretName, secretValue, policy)
      }
      await api.upstreams.add({ name, url, bearer_secret: secretName || undefined, auth_header: header || undefined })
      onDone(name)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} title="Add server" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm opacity-70">Start from:</span>
          {presets.map((p) => (
            <Button key={p.name} size="sm" variant="outline" onPress={() => usePreset(p)}>
              {p.label}
            </Button>
          ))}
        </div>
        {error ? <Banner title={error} /> : null}
        <TextField isRequired value={name} onChange={setName}>
          <Label>Name</Label>
          <Input autoComplete="off" spellCheck={false} />
        </TextField>
        <TextField isRequired value={url} onChange={setUrl}>
          <Label>Address (MCP endpoint)</Label>
          <Input autoComplete="off" spellCheck={false} placeholder="https://example.com/mcp" />
        </TextField>
        <TextField value={secretName} onChange={setSecretName}>
          <Label>Secret name (optional)</Label>
          <Input autoComplete="off" spellCheck={false} placeholder="GITHUB_PAT" />
        </TextField>
        <TextField value={header} onChange={setHeader}>
          <Label>Key header (optional)</Label>
          <Input autoComplete="off" spellCheck={false} placeholder="leave empty for a standard sign-in key; Composio uses x-api-key" />
        </TextField>
        <TextField type="password" value={secretValue} onChange={setSecretValue}>
          <Label>Secret value (optional, stored encrypted, never shown again)</Label>
          <Input autoComplete="new-password" />
        </TextField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isPending={busy}>
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SecretDialog({ u, onClose, onDone }: { u: Upstream | null; onClose: () => void; onDone: (text: string) => void }) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [header, setHeader] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    setName(u ? u.bearer_secret || secretNameFor(u.name) : "")
    setHeader(u?.auth_header ?? "")
    setValue("")
    setError("")
  }, [u])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!u) return
    if (!secretRe.test(name)) return setError("Secret name looks like GITHUB_PAT: capital letters, digits, underscore.")
    if (header && !headerRe.test(header)) return setError("Key header: letters, digits and dashes, for example x-api-key.")
    const headerChanged = header !== (u.auth_header ?? "")
    if (!value && !headerChanged) return setError("Paste the secret value.")
    setBusy(true)
    setError("")
    try {
      if (value) {
        // a brand-new secret is pinned to this server's host; rotating an existing one keeps its stored policy
        await api.secrets.put(name, value, u.secret_set && name === u.bearer_secret ? undefined : bearerPolicy(u.url))
      }
      const patch: { bearer_secret?: string; auth_header?: string } = {}
      if (value && name !== u.bearer_secret) patch.bearer_secret = name
      if (headerChanged) patch.auth_header = header
      if (Object.keys(patch).length) await api.upstreams.patch(u.name, patch)
      setValue("")
      onDone(value ? `Secret ${name} saved for ${u.name}.` : `Key header saved for ${u.name}.`)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!u?.bearer_secret) return
    setBusy(true)
    try {
      await api.secrets.remove(u.bearer_secret)
      onDone(`Secret ${u.bearer_secret} deleted.`)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={u !== null} title={u ? `Secret for ${u.name}` : "Secret"} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm opacity-70">
          The value is sent once over HTTPS, stored encrypted and never shown again. Saving a new value replaces the old one at once. The secret can only be sent to <code className="mono">{u ? safeHost(u.url) : ""}</code>.
        </p>
        {u?.bearer_env ? <p className="text-sm opacity-70">This server can also use the environment variable <code className="mono">{u.bearer_env}</code>; the stored secret wins.</p> : null}
        {error ? <Banner title={error} /> : null}
        <TextField isRequired value={name} onChange={setName}>
          <Label>Secret name</Label>
          <Input autoComplete="off" spellCheck={false} />
        </TextField>
        <TextField value={header} onChange={setHeader}>
          <Label>Key header (optional)</Label>
          <Input autoComplete="off" spellCheck={false} placeholder="leave empty for a standard sign-in key; Composio uses x-api-key" />
        </TextField>
        <TextField type="password" value={value} onChange={setValue}>
          <Label>Value</Label>
          <Input autoComplete="new-password" />
        </TextField>
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            {u?.secret_set && u.bearer_secret ? (
              <Button variant="danger" isPending={busy} onPress={() => void remove()}>
                Delete stored secret
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onPress={onClose}>
              Cancel
            </Button>
            <Button type="submit" isPending={busy}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

export function Servers() {
  const [rows, setRows] = useState<Upstream[] | null>(null)
  const [error, setError] = useState("")
  const [note, setNote] = useState<{ status: BannerStatus; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [secretFor, setSecretFor] = useState<Upstream | null>(null)
  const [removing, setRemoving] = useState<Upstream | null>(null)
  const [testing, setTesting] = useState("")
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows(await api.upstreams.list())
      setError("")
    } catch (e) {
      setError(msg(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10000)
    return () => clearInterval(t)
  }, [load])

  async function test(name: string) {
    setTesting(name)
    try {
      const r = await api.upstreams.test(name)
      setNote(r.ok ? { status: "success", text: `${name}: connected, ${r.tools.length} tools in ${r.millis} ms.` } : { status: "danger", text: `${name}: ${r.error || "failed"}` })
    } catch (e) {
      setNote({ status: "danger", text: `${name}: ${msg(e)}` })
    } finally {
      setTesting("")
      void load()
    }
  }

  async function toggle(u: Upstream, enabled: boolean) {
    try {
      await api.upstreams.patch(u.name, { enabled })
    } catch (e) {
      setNote({ status: "danger", text: `${u.name}: ${msg(e)}` })
    }
    void load()
  }

  async function remove() {
    if (!removing) return
    setBusy(true)
    try {
      await api.upstreams.remove(removing.name)
      setNote({ status: "success", text: `${removing.name} removed.` })
      setRemoving(null)
    } catch (e) {
      setNote({ status: "danger", text: `${removing.name}: ${msg(e)}` })
      setRemoving(null)
    } finally {
      setBusy(false)
      void load()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Servers</h1>
          <p className="text-sm opacity-70">MCP servers Cammut connects to. Agents see them through one endpoint.</p>
        </div>
        <Button onPress={() => setAdding(true)}>Add server</Button>
      </div>

      {error ? <Banner title={error} /> : null}
      {note ? <Banner status={note.status} title={note.text} /> : null}

      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="MCP servers" className="min-w-[760px]">
            <Table.Header>
              <Table.Column isRowHeader>Name</Table.Column>
              <Table.Column>Status</Table.Column>
              <Table.Column>Tools</Table.Column>
              <Table.Column>Address</Table.Column>
              <Table.Column>Secret</Table.Column>
              <Table.Column>Actions</Table.Column>
            </Table.Header>
            <Table.Body items={rows ?? []}>
              {(u: Upstream) => (
                <Table.Row id={u.name}>
                  <Table.Cell>
                    <span className="font-medium">{u.name}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-col gap-1">
                      <StatusChip u={u} />
                      {u.status === "unreachable" && u.last_error ? <span className="max-w-[200px] truncate text-xs opacity-70" title={u.last_error}>{u.last_error}</span> : null}
                    </div>
                  </Table.Cell>
                  <Table.Cell>{u.tools}</Table.Cell>
                  <Table.Cell>
                    <span className="mono block max-w-[260px] truncate text-xs" title={u.url}>{u.url}</span>
                  </Table.Cell>
                  <Table.Cell>
                    {u.bearer_secret || u.bearer_env ? (
                      <Chip color={u.secret_set ? "success" : "warning"} variant="soft" size="sm">
                        {(u.bearer_secret || u.bearer_env) + (u.secret_set ? " set" : " missing")}
                      </Chip>
                    ) : (
                      <span className="text-xs opacity-60">none</span>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary" isPending={testing === u.name} onPress={() => void test(u.name)}>
                        Test
                      </Button>
                      <Button size="sm" variant="secondary" onPress={() => setSecretFor(u)}>
                        Secret
                      </Button>
                      <Switch isSelected={u.enabled} onChange={(v) => void toggle(u, v)} aria-label={`Enable ${u.name}`}>
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                        </Switch.Content>
                      </Switch>
                      <Button size="sm" variant="danger" onPress={() => setRemoving(u)}>
                        Remove
                      </Button>
                    </div>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {rows !== null && rows.length === 0 ? <p className="text-sm opacity-70">No servers yet. Add one, for example GitHub.</p> : null}

      <AddServer
        open={adding}
        onClose={() => setAdding(false)}
        onDone={(name) => {
          setAdding(false)
          void load()
          void test(name)
        }}
      />
      <SecretDialog
        u={secretFor}
        onClose={() => setSecretFor(null)}
        onDone={(text) => {
          setSecretFor(null)
          setNote({ status: "success", text })
          void load()
        }}
      />
      <Confirm
        open={removing !== null}
        title="Remove server"
        body={removing ? `Remove ${removing.name}? Agents lose access to its tools at once. Its stored secret is kept.` : ""}
        confirmLabel="Remove"
        danger
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
