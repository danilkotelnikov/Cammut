import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CommandPalette } from "./CommandPalette"

const make = () => {
  const run = { servers: vi.fn(), tokens: vi.fn() }
  const commands = [
    { id: "servers", label: "Servers", hint: "Go to", run: run.servers },
    { id: "tokens", label: "Tokens", hint: "Go to", run: run.tokens },
  ]
  return { run, commands }
}

describe("CommandPalette", () => {
  it("renders nothing while closed", () => {
    const { commands } = make()
    render(<CommandPalette open={false} commands={commands} onClose={() => {}} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("filters, moves with the arrow keys, runs on Enter and closes", async () => {
    const user = userEvent.setup()
    const { commands, run } = make()
    const onClose = vi.fn()
    render(<CommandPalette open commands={commands} onClose={onClose} />)
    expect(screen.getAllByRole("option")).toHaveLength(2)
    await user.keyboard("{ArrowDown}{Enter}")
    expect(run.tokens).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it("filters by what is typed and says when nothing matches", async () => {
    const user = userEvent.setup()
    const { commands } = make()
    render(<CommandPalette open commands={commands} onClose={() => {}} />)
    await user.type(screen.getByRole("combobox"), "tok")
    expect(screen.getAllByRole("option")).toHaveLength(1)
    await user.type(screen.getByRole("combobox"), "zzz")
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument()
  })

  it("closes on Escape", async () => {
    const user = userEvent.setup()
    const { commands } = make()
    const onClose = vi.fn()
    render(<CommandPalette open commands={commands} onClose={onClose} />)
    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })
})
