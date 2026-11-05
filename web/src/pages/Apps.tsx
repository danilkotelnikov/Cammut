import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Button, Chip, Input, Label, TextField } from "@heroui/react"
import { api, ApiError, type OAuthClient } from "../api"
import { parseScopes, relativeTime, scopeProblem } from "../format"
import { Banner, type BannerStatus } from "../components/Banner"
import { Confirm, Dialog } from "../components/Dialog"

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.")

/** Splits a pasted list of web addresses (commas, spaces or new lines). */
export const parseUris = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean)

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs opacity-70">{label}</span>
      <div className="flex items-start gap-2">
        <code className="mono block min-w-0 flex-1 break-all rounded-lg border border-current/30 p-2 text-sm" data-testid={secret ? "client-secret" : undefined}>
          {value}
        </code>
        <Button size="sm" variant="secondary" onPress={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

type Created = { name: string; id: string; secret: string }

function NewApp({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Created) => void }) {
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState("")
  const [uris, setUris] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError("")
    const list = parseScopes(scopes)
    const bad = list.length === 0 ? "Choose at least one scope." : scopeProblem(list)
    if (bad) return setError(bad)
    setBusy(true)
    try {
      const r = await api.oauth.create({ name: name.trim(), redirect_uris: parseUris(uris), scopes: list })
      onCreated({ name: name.trim(), id: r.client_id, secret: r.client_secret })
      setName("")
      setScopes("")
      setUris("")
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} title="New app" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Banner title={error} /> : null}
        <TextField isRequired value={name} onChange={setName}>
          <Label>Name</Label>
          <Input autoComplete="off" spellCheck={false} placeholder="Gemini" />
        </TextField>
        <label className="flex flex-col gap-1 text-sm">
          <span>Scopes (what the app may use)</span>
          <textarea
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="hindsight/recall, hindsight/retain"
            className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
          />
          <span className="text-xs opacity-60">Same form as a token: server/tool, with * as a wildcard.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Redirect addresses (optional now)</span>
          <textarea
            value={uris}
            onChange={(e) => setUris(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder="https://…"
            className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
          />
          <span className="text-xs opacity-60">The app shows its own address when you connect it. If you do not have it yet, leave this empty and add it later.</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isPending={busy}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function Reveal({ c, onClose }: { c: Created | null; onClose: () => void }) {
  const origin = window.location.origin
  return (
    <Dialog open={c !== null} title={c ? `App ${c.name}` : "App"} onClose={onClose} footer={<Button onPress={onClose}>I have saved it</Button>}>
      <div className="flex flex-col gap-3">
        <Banner status="warning" title="The Client secret is shown only once.">
          Cammut keeps only a hash. If you lose it, remove the app and make a new one.
        </Banner>
        <CopyField label="Client ID" value={c?.id ?? ""} />
        <CopyField label="Client secret" value={c?.secret ?? ""} secret />
        <CopyField label="MCP server address" value={`${origin}/mcp`} />
        <CopyField label="Authorization URL (if asked)" value={`${origin}/oauth/authorize`} />
        <CopyField label="Token URL (if asked)" value={`${origin}/oauth/token`} />
      </div>
    </Dialog>
  )
}

function EditUris({ c, onClose, onDone }: { c: OAuthClient | null; onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    setText(c ? c.redirect_uris.join("\n") : "")
    setError("")
  }, [c])
  async function save(e: FormEvent) {
    e.preventDefault()
    if (!c) return
    setBusy(true)
    try {
      await api.oauth.setRedirects(c.id, parseUris(text))
      onDone(`Redirect addresses of ${c.name} updated.`)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={c !== null} title={c ? `Redirect addresses of ${c.name}` : "Redirect addresses"} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-4">
        {error ? <Banner title={error} /> : null}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          spellCheck={false}
          aria-label="Redirect addresses"
          placeholder="https://…"
          className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
        />
        <span className="text-xs opacity-60">One per line. An address must start with https:// and match what the app sends, character for character.</span>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isPending={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function Apps() {
  const [rows, setRows] = useState<OAuthClient[] | null>(null)
  const [error, setError] = useState("")
  const [note, setNote] = useState<{ status: BannerStatus; text: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const [editing, setEditing] = useState<OAuthClient | null>(null)
  const [removing, setRemoving] = useState<OAuthClient | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows(await api.oauth.clients())
      setError("")
    } catch (e) {
      setError(msg(e))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function remove() {
    if (!removing) return
    setBusy(true)
    try {
      await api.oauth.remove(removing.id)
      setNote({ status: "success", text: `${removing.name} removed. Its tokens stop working at once.` })
    } catch (e) {
      setNote({ status: "danger", text: `${removing.name}: ${msg(e)}` })
    } finally {
      setBusy(false)
      setRemoving(null)
      void load()
    }
  }

  async function disconnect(g: number) {
    try {
      await api.oauth.removeGrant(g)
      setNote({ status: "success", text: "Connection ended. The app has to be approved again to reconnect." })
    } catch (e) {
      setNote({ status: "danger", text: msg(e) })
    }
    void load()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Apps</h1>
          <p className="text-sm opacity-70">Apps that sign in with OAuth, such as the Gemini app. You approve each connection here and can end it any time.</p>
        </div>
        <Button onPress={() => setCreating(true)}>New app</Button>
      </div>

      {error ? <Banner title={error} /> : null}
      {note ? <Banner status={note.status} title={note.text} /> : null}

      {rows?.map((c) => (
        <section key={c.id} className="cm-glass flex flex-col gap-3 rounded-2xl p-4" aria-label={c.name}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{c.name}</h2>
              <code className="mono text-xs opacity-70">{c.id}</code>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onPress={() => setEditing(c)}>
                Addresses
              </Button>
              <Button size="sm" variant="danger" onPress={() => setRemoving(c)}>
                Remove
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {c.scopes.map((s) => (
              <Chip key={s} size="sm" variant="secondary">
                {s}
              </Chip>
            ))}
          </div>
          {c.redirect_uris.length === 0 ? (
            <p className="text-xs opacity-70">No redirect address yet. Connect the app once; the error page names the address to add here.</p>
          ) : (
            <ul className="mono text-xs opacity-70">
              {c.redirect_uris.map((u) => (
                <li key={u} className="break-all">
                  {u}
                </li>
              ))}
            </ul>
          )}
          {c.grants.length === 0 ? (
            <p className="text-sm opacity-70">Not connected yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {c.grants.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    Connected {relativeTime(g.created_at)}, last used {relativeTime(g.last_used_at)}
                  </span>
                  <Button size="sm" variant="secondary" onPress={() => void disconnect(g.id)}>
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {rows !== null && rows.length === 0 ? <p className="text-sm opacity-70">No apps yet.</p> : null}

      <NewApp
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(c) => {
          setCreating(false)
          setCreated(c)
          void load()
        }}
      />
      <Reveal c={created} onClose={() => setCreated(null)} />
      <EditUris
        c={editing}
        onClose={() => setEditing(null)}
        onDone={(text) => {
          setEditing(null)
          setNote({ status: "success", text })
          void load()
        }}
      />
      <Confirm
        open={removing !== null}
        title="Remove app"
        body={removing ? `Remove ${removing.name}? It is disconnected and every token it holds stops working at once.` : ""}
        confirmLabel="Remove"
        danger
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
