import { useCallback, useEffect, useReducer, useState, type FormEvent } from "react"
import { Button, Chip, Input, Label, Table, TextField } from "@heroui/react"
import { api, ApiError, type TokenRow } from "../api"
import { parseScopes, relativeTime, scopeProblem, tokenState } from "../format"
import { Banner, type BannerStatus } from "../components/Banner"
import { Confirm, Dialog } from "../components/Dialog"

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.")

type Reveal = { token: string; label: string } | null
type RevealAction = { type: "created"; token: string; label: string } | { type: "close" }

/** The plaintext of a new token exists in state only between creation and closing the reveal dialog. */
export function revealReducer(_state: Reveal, a: RevealAction): Reveal {
  return a.type === "created" ? { token: a.token, label: a.label } : null
}

const expiries = [
  { label: "Never", hours: 0 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "90 days", hours: 24 * 90 },
  { label: "1 year", hours: 24 * 365 },
]

const labelRe = /^[A-Za-z0-9._-]{1,40}$/

function NewToken({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (token: string, label: string) => void }) {
  const [label, setLabel] = useState("")
  const [scopes, setScopes] = useState("")
  const [hours, setHours] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError("")
    const list = parseScopes(scopes)
    if (!labelRe.test(label)) return setError("Label: letters, digits, . _ - (max 40).")
    const bad = scopeProblem(list)
    if (bad) return setError(bad)
    setBusy(true)
    try {
      const t = await api.tokens.create({ label, scopes: list, expires_in_hours: hours || undefined })
      onCreated(t.token, t.label)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} title="New token" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Banner title={error} /> : null}
        <TextField isRequired value={label} onChange={setLabel}>
          <Label>Label</Label>
          <Input autoComplete="off" spellCheck={false} placeholder="warp" />
        </TextField>
        <label className="flex flex-col gap-1 text-sm">
          <span>Scopes (what the token may use)</span>
          <textarea
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="github/*, hindsight/recall"
            className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
          />
          <span className="text-xs opacity-60">Form: server/tool, with * as a wildcard. Separate with commas, spaces or new lines. No scopes means no access.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Expires</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm">
            {expiries.map((x) => (
              <option key={x.hours} value={x.hours} className="text-black">
                {x.label}
              </option>
            ))}
          </select>
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

function EditScopes({ t, onClose, onDone }: { t: TokenRow | null; onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    setText(t ? t.scopes.join("\n") : "")
    setError("")
  }, [t])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!t) return
    const list = parseScopes(text)
    const bad = scopeProblem(list)
    if (bad) return setError(bad)
    setBusy(true)
    try {
      await api.tokens.setScopes(t.label, list)
      onDone(`Scopes of ${t.label} updated.`)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={t !== null} title={t ? `Scopes of ${t.label}` : "Scopes"} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-4">
        {error ? <Banner title={error} /> : null}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          spellCheck={false}
          aria-label="Scopes"
          className="mono rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
        />
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

function RevealDialog({ reveal, onClose }: { reveal: Reveal; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => setCopied(false), [reveal])
  async function copy() {
    if (!reveal) return
    try {
      await navigator.clipboard.writeText(reveal.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <Dialog
      open={reveal !== null}
      title={reveal ? `Token ${reveal.label}` : "Token"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onPress={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button onPress={onClose}>I have saved it</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Banner status="warning" title="This is the only time the token is shown.">
          Cammut keeps only a hash. If you lose it, revoke it and create another.
        </Banner>
        <code className="mono block break-all rounded-lg border border-current/30 p-3 text-sm" data-testid="token-plaintext">
          {reveal?.token}
        </code>
      </div>
    </Dialog>
  )
}

export function Tokens() {
  const [rows, setRows] = useState<TokenRow[] | null>(null)
  const [error, setError] = useState("")
  const [note, setNote] = useState<{ status: BannerStatus; text: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [reveal, dispatch] = useReducer(revealReducer, null)
  const [editing, setEditing] = useState<TokenRow | null>(null)
  const [revoking, setRevoking] = useState<TokenRow | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setRows(await api.tokens.list())
      setError("")
    } catch (e) {
      setError(msg(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function revoke() {
    if (!revoking) return
    setBusy(true)
    try {
      await api.tokens.revoke(revoking.label)
      setNote({ status: "success", text: `${revoking.label} revoked. It stops working at once.` })
    } catch (e) {
      setNote({ status: "danger", text: `${revoking.label}: ${msg(e)}` })
    } finally {
      setBusy(false)
      setRevoking(null)
      void load()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tokens</h1>
          <p className="text-sm opacity-70">Credentials for agents (Claude Code, Warp, others). Each sees only what its scopes allow.</p>
        </div>
        <Button onPress={() => setCreating(true)}>New token</Button>
      </div>

      {error ? <Banner title={error} /> : null}
      {note ? <Banner status={note.status} title={note.text} /> : null}

      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Tokens" className="min-w-[760px]">
            <Table.Header>
              <Table.Column isRowHeader>Label</Table.Column>
              <Table.Column>Scopes</Table.Column>
              <Table.Column>State</Table.Column>
              <Table.Column>Expires</Table.Column>
              <Table.Column>Last used</Table.Column>
              <Table.Column>Actions</Table.Column>
            </Table.Header>
            <Table.Body items={rows ?? []}>
              {(t: TokenRow) => {
                const state = tokenState(t)
                return (
                  <Table.Row id={t.id}>
                    <Table.Cell>
                      <span className="font-medium">{t.label}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex max-w-[280px] flex-wrap gap-1">
                        {t.scopes.length === 0 ? <span className="text-xs opacity-60">none</span> : t.scopes.map((s) => (
                          <Chip key={s} size="sm" variant="secondary">
                            {s}
                          </Chip>
                        ))}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" variant="soft" color={state === "active" ? "success" : state === "expired" ? "warning" : "default"}>
                        {state}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>{t.expires_at ? relativeTime(t.expires_at) : "never"}</Table.Cell>
                    <Table.Cell>{relativeTime(t.last_used_at)}</Table.Cell>
                    <Table.Cell>
                      {state === "revoked" ? null : (
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onPress={() => setEditing(t)}>
                            Scopes
                          </Button>
                          <Button size="sm" variant="danger" onPress={() => setRevoking(t)}>
                            Revoke
                          </Button>
                        </div>
                      )}
                    </Table.Cell>
                  </Table.Row>
                )
              }}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {rows !== null && rows.length === 0 ? <p className="text-sm opacity-70">No tokens yet.</p> : null}

      <NewToken
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(token, label) => {
          setCreating(false)
          dispatch({ type: "created", token, label })
          void load()
        }}
      />
      <RevealDialog reveal={reveal} onClose={() => dispatch({ type: "close" })} />
      <EditScopes
        t={editing}
        onClose={() => setEditing(null)}
        onDone={(text) => {
          setEditing(null)
          setNote({ status: "success", text })
          void load()
        }}
      />
      <Confirm
        open={revoking !== null}
        title="Revoke token"
        body={revoking ? `Revoke ${revoking.label}? Every agent using it loses access at once. This cannot be undone.` : ""}
        confirmLabel="Revoke"
        danger
        busy={busy}
        onClose={() => setRevoking(null)}
        onConfirm={() => void revoke()}
      />
    </div>
  )
}
