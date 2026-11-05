import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>()
  return {
    ...real,
    api: {
      ...real.api,
      memory: { projects: vi.fn(), notes: vi.fn(), brief: vi.fn(), status: vi.fn(), retract: vi.fn(), history: vi.fn(), confirm: vi.fn(), review: vi.fn(), resolveReview: vi.fn() },
      archiveAlerts: vi.fn(),
    },
  }
})

import { api, ApiError, type MemBrief, type MemNote, type MemStatus } from "../api"
import { Memory } from "./Memory"

const note = (over: Partial<MemNote> = {}): MemNote => ({
  id: "01J0000000000000000000000A",
  project: "Cammut",
  kind: "decision",
  epistemic: "inferred",
  title: "Use FTS5",
  body: "because it ships in the driver",
  tags: ["sqlite", "search"],
  status: "active",
  importance: 3,
  source_agent: "mcp:claude-code",
  created_at: "2026-10-11T10:00:00Z",
  updated_at: "2026-10-11T10:00:00Z",
  ...over,
})

const status = (over: Partial<MemStatus> = {}): MemStatus => ({
  projects: 2,
  notes: 41,
  briefs: 2,
  queue: 0,
  failures_24h: 0,
  last_ingest: "0001-01-01T00:00:00Z",
  last_consolidation: "0001-01-01T00:00:00Z",
  ...over,
})

const brief = (over: Partial<MemBrief> = {}): MemBrief => ({
  project: "Cammut",
  version: 7,
  generator: "template",
  stale: false,
  tier: "core",
  tokens: 1480,
  generated_at: "2026-10-11T10:05:00Z",
  body: "# Cammut — brief\n\n## Decisions in force\n- **Use FTS5** — because it ships in the driver (000000a1)\n",
  accounting: { active: 41, full: 20, gist: 3, index: 10, paged: 8 },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.memory.projects).mockResolvedValue([
    { name: "Cammut", notes: 30, last_activity: "2026-10-11T10:00:00Z", brief_version: 7 },
    { name: "Other", notes: 11, last_activity: null, brief_version: 1 },
  ])
  vi.mocked(api.memory.notes).mockResolvedValue([note(), note({ id: "01J0000000000000000000000B", kind: "finding", title: "TEI is heavy", body: "851 MiB", tags: [], source_agent: "mcp:warp" })])
  vi.mocked(api.memory.status).mockResolvedValue(status())
  vi.mocked(api.memory.brief).mockResolvedValue(brief())
  vi.mocked(api.memory.retract).mockResolvedValue(undefined)
  vi.mocked(api.memory.review).mockResolvedValue([])
  vi.mocked(api.memory.resolveReview).mockResolvedValue(undefined)
  vi.mocked(api.archiveAlerts).mockResolvedValue({ segments: 5, recipient_changes: 0, replica_last_run_at: "2026-10-12T01:00:00Z", replica_stale: false, unreplicated: 0 })
})

describe("Memory", () => {
  it("lists supersession suggestions and applies or dismisses them only on a click", async () => {
    vi.mocked(api.memory.review).mockResolvedValue([
      { id: 7, project: "Cammut", cosine: 0.88, note: note({ id: "NEW", title: "Deploy host", body: "runs on beta" }), candidate: note({ id: "OLD", title: "Deploy host", body: "runs on alpha" }) },
    ])
    const user = userEvent.setup()
    render(<Memory />)
    const section = await screen.findByLabelText("Suggested replacements")
    expect(section).toHaveTextContent("runs on beta")
    expect(section).toHaveTextContent("runs on alpha")
    expect(section).toHaveTextContent("0.88")
    expect(api.memory.resolveReview).not.toHaveBeenCalled()
    await user.click(within(section).getByRole("button", { name: "Replace the old note" }))
    await waitFor(() => expect(api.memory.resolveReview).toHaveBeenCalledWith(7, "apply"))
    await user.click(within(await screen.findByLabelText("Suggested replacements")).getByRole("button", { name: "Keep both" }))
    await waitFor(() => expect(api.memory.resolveReview).toHaveBeenCalledWith(7, "dismiss"))
  })

  it("shows no suggestions section when the queue is empty", async () => {
    render(<Memory />)
    await screen.findByText("Use FTS5")
    expect(screen.queryByLabelText("Suggested replacements")).not.toBeInTheDocument()
  })

  it("marks guesses and lets a person confirm them as observed", async () => {
    vi.mocked(api.memory.notes).mockResolvedValue([note({ id: "GUESS", title: "Hiring plan", epistemic: "speculative" }), note({ id: "SEEN", title: "Saw it", epistemic: "observed" })])
    vi.mocked(api.memory.confirm).mockResolvedValue(note({ id: "GUESS", epistemic: "observed" }))
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByText("Hiring plan")
    expect(screen.getByText("speculative")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(api.memory.confirm).toHaveBeenCalledWith("GUESS", "observed"))
    await waitFor(() => expect(vi.mocked(api.memory.notes).mock.calls.length).toBeGreaterThan(1))
  })

  it("shows a note's key and its history, current version first", async () => {
    vi.mocked(api.memory.notes).mockResolvedValue([note({ id: "NEW", kind: "state", key: "cammut.deployed", title: "Cammut deployed", body: "version 0.3.0" })])
    vi.mocked(api.memory.history).mockResolvedValue([
      note({ id: "NEW", kind: "state", key: "cammut.deployed", title: "Cammut deployed", body: "version 0.3.0" }),
      note({ id: "OLD", kind: "state", key: "cammut.deployed", title: "Cammut deployed", body: "version 0.2.0", status: "superseded" }),
    ])
    const user = userEvent.setup()
    render(<Memory />)
    expect(await screen.findByText("cammut.deployed")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "History" }))
    const panel = await screen.findByLabelText("History of cammut.deployed")
    expect(vi.mocked(api.memory.history)).toHaveBeenCalledWith("Cammut", "cammut.deployed")
    expect(panel).toHaveTextContent("version 0.3.0")
    expect(panel).toHaveTextContent("version 0.2.0")
    expect(panel).toHaveTextContent("superseded")
  })

  it("lists the projects, the notes of the first one and the status strip", async () => {
    render(<Memory />)
    expect(await screen.findByText("Use FTS5")).toBeInTheDocument()
    expect(screen.getByText("TEI is heavy")).toBeInTheDocument()
    expect(screen.getByText("mcp:warp")).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Other" })).toBeInTheDocument()
    expect(vi.mocked(api.memory.notes).mock.calls[0][0]).toMatchObject({ project: "Cammut" })
    const strip = screen.getByLabelText("Memory status")
    expect(strip).toHaveTextContent("41 notes")
  })

  it("filters by kind and by search text, asking the server", async () => {
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByText("Use FTS5")
    await user.selectOptions(screen.getByLabelText("Kind"), "finding")
    await waitFor(() => expect(vi.mocked(api.memory.notes).mock.calls.at(-1)![0]).toMatchObject({ project: "Cammut", kind: "finding" }))
    await user.type(screen.getByLabelText("Search"), "driver")
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(vi.mocked(api.memory.notes).mock.calls.at(-1)![0]).toMatchObject({ kind: "finding", q: "driver" }))
  })

  it("expands a note to its body and tags", async () => {
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByText("Use FTS5")
    expect(screen.queryByText("because it ships in the driver")).not.toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Show" })[0])
    expect(await screen.findByText("because it ships in the driver")).toBeInTheDocument()
    expect(screen.getByText("sqlite")).toBeInTheDocument()
  })

  it("retracts only after the confirmation, then reloads", async () => {
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByText("Use FTS5")
    await user.click(screen.getAllByRole("button", { name: "Retract" })[0])
    expect(api.memory.retract).not.toHaveBeenCalled()
    await user.click(await screen.findByRole("button", { name: "Retract note" }))
    await waitFor(() => expect(api.memory.retract).toHaveBeenCalledWith("01J0000000000000000000000A"))
    await waitFor(() => expect(vi.mocked(api.memory.notes).mock.calls.length).toBeGreaterThan(1))
  })

  it("cancelling the confirmation retracts nothing", async () => {
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByText("Use FTS5")
    await user.click(screen.getAllByRole("button", { name: "Retract" })[0])
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(api.memory.retract).not.toHaveBeenCalled()
  })

  it("shows the brief as preformatted text with its accounting", async () => {
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByText("Use FTS5")
    await user.click(screen.getByRole("tab", { name: "Brief" }))
    const pre = await screen.findByText(/## Decisions in force/)
    expect(pre.tagName).toBe("PRE")
    expect(pre).toHaveTextContent("(000000a1)")
    expect(screen.getByText(/version 7/)).toBeInTheDocument()
    expect(screen.getByText(/41 active = 20 full \+ 3 gist \+ 10 index \+ 8 paged/)).toBeInTheDocument()
  })

  it("says which pages the last session was sent and which not", async () => {
    vi.mocked(api.memory.status).mockResolvedValue(
      status({ delivery: { agent: "mcp:claude-code", last_session: "s1", at: "2026-10-11T10:06:00Z", brief_version: 7, delivered: ["core", "p-key-files-2"], not_delivered: ["p-key-files-1"] } }),
    )
    render(<Memory />)
    const panel = await screen.findByLabelText("Delivery")
    expect(panel).toHaveTextContent("mcp:claude-code")
    expect(panel).toHaveTextContent("core, p-key-files-2")
    expect(within(panel).getByText(/not recorded/i)).toBeInTheDocument()
    expect(panel).toHaveTextContent("p-key-files-1")
    expect(panel).toHaveTextContent(/server recorded.*not client-confirmed/i)
  })

  it("turns the strip red for archive alerts, and hides the archive line when there is no archive", async () => {
    vi.mocked(api.archiveAlerts).mockResolvedValue({ segments: 9, recipient_changes: 1, replica_last_run_at: null, replica_stale: true, unreplicated: 4 })
    const { unmount } = render(<Memory />)
    const strip = await screen.findByLabelText("Memory status")
    await waitFor(() => expect(strip).toHaveAttribute("data-alert", "true"))
    expect(await screen.findByText(/recipient set changed for 1 project/i)).toBeInTheDocument()
    expect(screen.getByText(/replica is missing or older than 36 h/i)).toBeInTheDocument()
    unmount()
    vi.mocked(api.archiveAlerts).mockRejectedValue(new ApiError(404, "not found"))
    vi.mocked(api.memory.status).mockResolvedValue(status())
    render(<Memory />)
    await screen.findByText("Use FTS5")
    expect(screen.queryByText(/archive/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText("Memory status")).toHaveAttribute("data-alert", "false")
  })

  it("explains an unreachable server instead of showing an empty list", async () => {
    vi.mocked(api.memory.projects).mockRejectedValue(new ApiError(0, "Could not reach the server."))
    render(<Memory />)
    expect(await screen.findByText("Could not reach the server.")).toBeInTheDocument()
  })

  it("has a useful empty state before any agent has written a note", async () => {
    vi.mocked(api.memory.projects).mockResolvedValue([])
    render(<Memory />)
    expect(await screen.findByText(/No notes yet/)).toBeInTheDocument()
  })

  it("does not overwrite a new project's notes or status with an earlier response", async () => {
    let oldNotes!: (value: MemNote[]) => void
    let oldStatus!: (value: MemStatus) => void
    vi.mocked(api.memory.notes).mockImplementation(({ project }) => project === "Cammut"
      ? new Promise((resolve) => { oldNotes = resolve })
      : Promise.resolve([note({ project: "Other", title: "Other project's decision" })]))
    vi.mocked(api.memory.status).mockImplementation((project) => project === "Cammut"
      ? new Promise((resolve) => { oldStatus = resolve })
      : Promise.resolve(status({ notes: 11 })))
    const user = userEvent.setup()
    render(<Memory />)
    await screen.findByRole("option", { name: "Other" })
    await waitFor(() => expect(api.memory.notes).toHaveBeenCalled())
    await user.selectOptions(screen.getByLabelText("Project"), "Other")
    await screen.findByText("Other project's decision")
    await act(async () => { oldNotes([note()]); oldStatus(status()) })
    expect(screen.queryByText("Use FTS5")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Memory status")).toHaveTextContent("11 notes")
  })
})
