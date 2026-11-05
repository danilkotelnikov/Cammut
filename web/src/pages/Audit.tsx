import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Button, Chip, Input, Label, Table, TextField } from "@heroui/react"
import { api, ApiError, type AuditQuery, type AuditRow, type TokenRow } from "../api"
import { formatTime } from "../format"
import { Banner } from "../components/Banner"

const PAGE = 50
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.")

type Filters = { upstream: string; tool: string; ok: "" | "true" | "false"; token: string }
const empty: Filters = { upstream: "", tool: "", ok: "", token: "" }

export function Audit() {
  const [draft, setDraft] = useState<Filters>(empty)
  const [applied, setApplied] = useState<Filters>(empty)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [more, setMore] = useState(false)
  const [tokens, setTokens] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    api.tokens.list().then((list: TokenRow[]) => setTokens(Object.fromEntries(list.map((t) => [t.id, t.label])))).catch(() => {})
  }, [])

  const fetchPage = useCallback(async (f: Filters, offset: number): Promise<AuditRow[]> => {
    const q: AuditQuery = { ...f, limit: PAGE, offset }
    return api.audit(q)
  }, [])

  const reload = useCallback(
    async (f: Filters) => {
      setLoading(true)
      setError("")
      try {
        const page = await fetchPage(f, 0)
        setRows(page)
        setMore(page.length === PAGE)
      } catch (e) {
        setError(msg(e))
      } finally {
        setLoading(false)
      }
    },
    [fetchPage],
  )

  useEffect(() => {
    void reload(applied)
  }, [applied, reload])

  async function loadMore() {
    setLoading(true)
    try {
      const page = await fetchPage(applied, rows.length)
      setRows((r) => [...r, ...page])
      setMore(page.length === PAGE)
    } catch (e) {
      setError(msg(e))
    } finally {
      setLoading(false)
    }
  }

  function apply(e: FormEvent) {
    e.preventDefault()
    setApplied({ ...draft })
  }

  const who = (r: AuditRow) => r.actor || (r.token_id ? tokens[r.token_id] || `token #${r.token_id}` : "—")

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit</h1>
        <p className="text-sm opacity-70">Every tool call and every console change. Arguments and secrets are never recorded.</p>
      </div>

      <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
        <TextField value={draft.upstream} onChange={(v) => setDraft({ ...draft, upstream: v })}>
          <Label>Server</Label>
          <Input placeholder="github, or admin" autoComplete="off" spellCheck={false} />
        </TextField>
        <TextField value={draft.tool} onChange={(v) => setDraft({ ...draft, tool: v })}>
          <Label>Tool contains</Label>
          <Input autoComplete="off" spellCheck={false} />
        </TextField>
        <TextField value={draft.token} onChange={(v) => setDraft({ ...draft, token: v })}>
          <Label>Token label</Label>
          <Input autoComplete="off" spellCheck={false} />
        </TextField>
        <label className="flex flex-col gap-1 text-sm">
          <span>Result</span>
          <select
            value={draft.ok}
            onChange={(e) => setDraft({ ...draft, ok: e.target.value as Filters["ok"] })}
            className="rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
          >
            <option value="" className="text-black">All</option>
            <option value="true" className="text-black">Succeeded</option>
            <option value="false" className="text-black">Failed</option>
          </select>
        </label>
        <Button type="submit" isPending={loading}>
          Apply
        </Button>
        <Button variant="secondary" onPress={() => { setDraft(empty); setApplied(empty) }}>
          Clear
        </Button>
      </form>

      {error ? <Banner title={error} /> : null}

      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Audit log" className="min-w-[860px]">
            <Table.Header>
              <Table.Column isRowHeader>Time</Table.Column>
              <Table.Column>Who</Table.Column>
              <Table.Column>Server</Table.Column>
              <Table.Column>Tool</Table.Column>
              <Table.Column>Result</Table.Column>
              <Table.Column>ms</Table.Column>
              <Table.Column>Address</Table.Column>
              <Table.Column>Note</Table.Column>
            </Table.Header>
            <Table.Body items={rows.map((r, i) => ({ ...r, key: `${r.ts}-${i}` }))}>
              {(r: AuditRow & { key: string }) => (
                <Table.Row id={r.key}>
                  <Table.Cell><span className="whitespace-nowrap text-xs">{formatTime(r.ts)}</span></Table.Cell>
                  <Table.Cell>{who(r)}</Table.Cell>
                  <Table.Cell>{r.upstream}</Table.Cell>
                  <Table.Cell><span className="mono text-xs">{r.tool}</span></Table.Cell>
                  <Table.Cell>
                    <Chip size="sm" variant="soft" color={r.ok ? "success" : "danger"}>
                      {r.ok ? "ok" : "failed"}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>{r.ms}</Table.Cell>
                  <Table.Cell><span className="mono text-xs">{r.ip}</span></Table.Cell>
                  <Table.Cell><span className="text-xs opacity-70">{r.note}</span></Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {!loading && rows.length === 0 && !error ? <p className="text-sm opacity-70">Nothing matches.</p> : null}
      {more ? (
        <div>
          <Button variant="secondary" isPending={loading} onPress={() => void loadMore()}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  )
}
