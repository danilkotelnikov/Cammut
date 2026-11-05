import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Button, Chip, Input, Label, Table, TextField } from "@heroui/react"
import { api, ApiError, type ArchiveAlerts, type MemBrief, type MemNote, type MemProject, type MemReview, type MemStatus } from "../api"
import { relativeTime } from "../format"
import { Banner } from "../components/Banner"
import { Confirm } from "../components/Dialog"

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.")
const kinds = ["decision", "finding", "codemap", "howto", "error_fix", "task", "state", "preference"]
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

type Tab = "notes" | "brief"

function StatusStrip({ status, alerts }: { status: MemStatus | null; alerts: ArchiveAlerts | null }) {
  const archiveAlert = alerts !== null && (alerts.recipient_changes > 0 || alerts.replica_stale)
  return (
    <div
      aria-label="Memory status"
      data-alert={archiveAlert ? "true" : "false"}
      className={"flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm " + (archiveAlert ? "border-red-500/60 bg-red-500/10" : "border-current/20")}
    >
      <div>
        {status ? `${plural(status.notes, "note")} · ${plural(status.briefs, "brief")}` : "Notes and briefs: loading…"}
      </div>
      {alerts && alerts.recipient_changes > 0 ? (
        <div className="text-red-600 dark:text-red-400">
          Archive recipient set changed for {plural(alerts.recipient_changes, "project")}. If you made the change, acknowledge it with <span className="mono">cammut archive pins ack</span>.
        </div>
      ) : null}
      {alerts && alerts.replica_stale ? (
        <div className="text-red-600 dark:text-red-400">
          Archive replica is missing or older than 36 h ({plural(alerts.unreplicated, "segment")} not replicated): transcripts on the PC will not be swept.
        </div>
      ) : null}
      {alerts && !archiveAlert ? (
        <div className="opacity-70">
          Archive: {plural(alerts.segments, "segment")}, replica verified {alerts.replica_last_run_at ? relativeTime(alerts.replica_last_run_at) : "never"}.
        </div>
      ) : null}
    </div>
  )
}

function Delivery({ d }: { d: NonNullable<MemStatus["delivery"]> }) {
  return (
    <section aria-label="Delivery" className="rounded-lg border border-current/20 px-3 py-2 text-sm">
      <p className="font-medium">
        Last session {d.last_session || "(no session id)"} · {d.agent} · brief v{d.brief_version} · {relativeTime(d.at)}
      </p>
      <p>
        Server recorded: <span className="mono">{d.delivered.length ? d.delivered.join(", ") : "nothing"}</span>
      </p>
      <p>
        Not recorded: <span className="mono">{d.not_delivered.length ? d.not_delivered.join(", ") : "none"}</span>
      </p>
      <p className="text-xs opacity-60">Server recorded this brief read before response completion; not client-confirmed. Emission, injection and agent consumption remain unknown.</p>
    </section>
  )
}

function NoteRow({ n, open, onToggle, onRetract, onHistory, onConfirm }: { n: MemNote; open: boolean; onToggle: () => void; onRetract: () => void; onHistory: () => void; onConfirm: () => void }) {
  return (
    <Table.Row id={n.id}>
      <Table.Cell>
        <Chip size="sm" variant="secondary">
          {n.kind}
        </Chip>
      </Table.Cell>
      <Table.Cell>
        <div className="flex flex-col gap-1">
          <span className="font-medium">{n.title}</span>
          {n.key ? <span className="mono text-xs opacity-70">{n.key}</span> : null}
          {open ? (
            <div className="flex flex-col gap-1">
              <p className="whitespace-pre-wrap text-sm">{n.body}</p>
              <div className="flex flex-wrap gap-1">
                {n.tags.map((t) => (
                  <Chip key={t} size="sm" variant="soft">
                    {t}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Table.Cell>
      <Table.Cell>
        <span className="whitespace-nowrap text-xs">{relativeTime(n.updated_at)}</span>
      </Table.Cell>
      <Table.Cell>
        <span className="text-xs">{n.source_agent}</span>
      </Table.Cell>
      <Table.Cell>
        <div className="flex flex-col items-start gap-1">
          <Chip size="sm" variant="soft" color={n.status === "active" ? "success" : "default"}>
            {n.status}
          </Chip>
          {n.epistemic !== "observed" ? (
            <Chip size="sm" variant="soft" color={n.epistemic === "speculative" ? "warning" : "default"}>
              {n.epistemic}
            </Chip>
          ) : null}
        </div>
      </Table.Cell>
      <Table.Cell>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onPress={onToggle}>
            {open ? "Hide" : "Show"}
          </Button>
          {n.status === "active" && n.epistemic !== "observed" ? (
            <Button size="sm" variant="secondary" onPress={onConfirm}>
              Confirm
            </Button>
          ) : null}
          {n.key ? (
            <Button size="sm" variant="secondary" onPress={onHistory}>
              History
            </Button>
          ) : null}
          {n.status === "active" ? (
            <Button size="sm" variant="danger" onPress={onRetract}>
              Retract
            </Button>
          ) : null}
        </div>
      </Table.Cell>
    </Table.Row>
  )
}

export function Memory() {
  const [projects, setProjects] = useState<MemProject[] | null>(null)
  const [project, setProject] = useState("")
  const [kind, setKind] = useState("")
  const [draft, setDraft] = useState("")
  const [q, setQ] = useState("")
  const [tab, setTab] = useState<Tab>("notes")
  const [notes, setNotes] = useState<MemNote[] | null>(null)
  const [status, setStatus] = useState<MemStatus | null>(null)
  const [alerts, setAlerts] = useState<ArchiveAlerts | null>(null)
  const [brief, setBrief] = useState<MemBrief | null>(null)
  const [openId, setOpenId] = useState("")
  const [retracting, setRetracting] = useState<MemNote | null>(null)
  const [hist, setHist] = useState<{ key: string; notes: MemNote[] } | null>(null)
  const [reviews, setReviews] = useState<MemReview[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const loadVersion = useRef(0)

  useEffect(() => {
    api.memory
      .projects()
      .then((list) => {
        setProjects(list)
        if (list.length > 0) setProject((p) => p || list[0].name)
      })
      .catch((e) => {
        setProjects([])
        setError(msg(e))
      })
    // a missing archive (or a server without the route) just leaves the line out
    api.archiveAlerts().then(setAlerts).catch(() => setAlerts(null))
  }, [])

  const load = useCallback(async () => {
    if (!project) return
    const version = ++loadVersion.current
    setNotes(null)
    setStatus(null)
    try {
      const [n, s, r] = await Promise.all([
        api.memory.notes({ project, kind, q, status: "any", limit: 200 }),
        api.memory.status(project),
        api.memory.review(project).catch(() => [] as MemReview[]),
      ])
      if (version !== loadVersion.current) return
      setNotes(n)
      setStatus(s)
      setReviews(r)
      setError("")
    } catch (e) {
      if (version !== loadVersion.current) return
      setError(msg(e))
    }
  }, [project, kind, q])

  useEffect(() => {
    void load()
    return () => { loadVersion.current++ }
  }, [load])

  useEffect(() => {
    if (tab !== "brief" || !project) return
    let active = true
    setBrief(null)
    api.memory
      .brief(project)
      .then((result) => { if (active) setBrief(result) })
      .catch((e) => { if (active) setError(msg(e)) })
    return () => { active = false }
  }, [tab, project])

  async function showHistory(key: string) {
    try {
      setHist({ key, notes: await api.memory.history(project, key) })
    } catch (e) {
      setError(msg(e))
    }
  }

  async function resolveReview(id: number, action: "apply" | "dismiss") {
    try {
      await api.memory.resolveReview(id, action)
      await load()
    } catch (e) {
      setError(msg(e))
    }
  }

  async function confirm(n: MemNote) {
    try {
      await api.memory.confirm(n.id, "observed")
      await load()
    } catch (e) {
      setError(msg(e))
    }
  }

  async function retract() {
    if (!retracting) return
    setBusy(true)
    try {
      await api.memory.retract(retracting.id)
      setRetracting(null)
      await load()
    } catch (e) {
      setError(msg(e))
      setRetracting(null)
    } finally {
      setBusy(false)
    }
  }

  function apply(e: FormEvent) {
    e.preventDefault()
    setQ(draft)
  }

  const empty = projects !== null && projects.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Memory</h1>
        <p className="text-sm opacity-70">Explicit agent notes and on-demand briefs. Connection or a stored brief does not prove automatic capture, injection or compaction recovery.</p>
      </div>

      {error ? <Banner title={error} /> : null}
      <StatusStrip status={status} alerts={alerts} />
      {reviews.length > 0 ? (
        <section aria-label="Suggested replacements" className="flex flex-col gap-2 rounded-lg border border-current/20 px-3 py-2 text-sm">
          <p className="font-medium">Suggested replacements ({reviews.length})</p>
          <p className="text-xs opacity-70">A newer note looks like an update of an older one. Nothing changes until you choose.</p>
          {reviews.map((r) => (
            <div key={r.id} className="flex flex-col gap-1 border-t border-current/10 pt-2">
              <p>
                <span className="opacity-70">New:</span> {r.note.title}. {r.note.body}
              </p>
              <p>
                <span className="opacity-70">Old:</span> {r.candidate.title}. {r.candidate.body}
              </p>
              <p className="text-xs opacity-70">similarity {r.cosine.toFixed(2)}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onPress={() => void resolveReview(r.id, "apply")}>
                  Replace the old note
                </Button>
                <Button size="sm" variant="secondary" onPress={() => void resolveReview(r.id, "dismiss")}>
                  Keep both
                </Button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {status?.delivery ? <Delivery d={status.delivery} /> : null}

      {empty ? (
        <p className="text-sm opacity-70">No notes yet. Agents save notes with memory_remember and memory_handoff; they appear here.</p>
      ) : (
        <>
          <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>Project</span>
              <select
                aria-label="Project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
              >
                {(projects ?? []).map((p) => (
                  <option key={p.name} value={p.name} className="text-black">
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Kind</span>
              <select
                aria-label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="rounded-lg border border-current/30 bg-transparent px-3 py-2 text-sm"
              >
                <option value="" className="text-black">
                  All kinds
                </option>
                {kinds.map((k) => (
                  <option key={k} value={k} className="text-black">
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <TextField value={draft} onChange={setDraft}>
              <Label>Search</Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
            <Button type="submit">Apply</Button>
          </form>

          <div role="tablist" aria-label="Memory views" className="flex gap-1">
            {(["notes", "brief"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={"rounded-md px-3 py-1.5 text-sm " + (tab === t ? "bg-[var(--foreground)] text-[var(--background)]" : "opacity-70 hover:opacity-100")}
              >
                {t === "notes" ? "Notes" : "Brief"}
              </button>
            ))}
          </div>

          {tab === "notes" ? (
            <>
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="Notes" className="min-w-[760px]">
                    <Table.Header>
                      <Table.Column>Kind</Table.Column>
                      <Table.Column isRowHeader>Title</Table.Column>
                      <Table.Column>Updated</Table.Column>
                      <Table.Column>Source</Table.Column>
                      <Table.Column>Status</Table.Column>
                      <Table.Column>Actions</Table.Column>
                    </Table.Header>
                    <Table.Body items={notes ?? []} dependencies={[openId]}>
                      {(n: MemNote) => (
                        <NoteRow n={n} open={openId === n.id} onToggle={() => setOpenId(openId === n.id ? "" : n.id)} onRetract={() => setRetracting(n)} onHistory={() => void showHistory(n.key ?? "")} onConfirm={() => void confirm(n)} />
                      )}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
              {notes !== null && notes.length === 0 ? <p className="text-sm opacity-70">Nothing matches.</p> : null}
              {hist ? (
                <section aria-label={`History of ${hist.key}`} className="rounded-lg border border-current/20 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">
                      History of <span className="mono">{hist.key}</span>, newest first
                    </p>
                    <Button size="sm" variant="secondary" onPress={() => setHist(null)}>
                      Close
                    </Button>
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {hist.notes.map((h) => (
                      <li key={h.id}>
                        <Chip size="sm" variant="soft" color={h.status === "active" ? "success" : "default"}>
                          {h.status}
                        </Chip>{" "}
                        {relativeTime(h.created_at)} · {h.body}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : brief ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                version {brief.version} · {brief.generator} · ~{brief.tokens} tokens (estimate){brief.stale ? " · stale" : ""}
              </p>
              <p className="text-xs opacity-70">Briefs can summarize notes or reference omitted detail by index/page. Expand relevant references before relying on them; accounting is not proof of semantic completeness.</p>
              <p className="text-sm opacity-70">
                {brief.accounting.active} active = {brief.accounting.full} full + {brief.accounting.gist} gist + {brief.accounting.index} index + {brief.accounting.paged} paged
              </p>
              <pre className="mono max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-current/20 p-3 text-xs">{brief.body}</pre>
            </div>
          ) : (
            <p className="text-sm opacity-70">Loading the brief…</p>
          )}
        </>
      )}

      <Confirm
        open={retracting !== null}
        title="Retract note"
        body={retracting ? `Retract “${retracting.title}”? It leaves recall and the next brief. The note itself is kept.` : ""}
        confirmLabel="Retract note"
        danger
        busy={busy}
        onClose={() => setRetracting(null)}
        onConfirm={() => void retract()}
      />
    </div>
  )
}
