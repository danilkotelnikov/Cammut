import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"

export type Command = { id: string; label: string; hint?: string; icon?: ReactNode; run: () => void }

// Ctrl+K (or Cmd+K): type to filter, arrow keys to move, Enter to run, Esc to close.
export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? commands.filter((c) => (c.label + " " + (c.hint ?? "")).toLowerCase().includes(q)) : commands
  }, [commands, query])

  useEffect(() => {
    if (open) {
      setQuery("")
      setActive(0)
      input.current?.focus()
    }
  }, [open])

  useEffect(() => setActive(0), [query])

  if (!open) return null

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => (shown.length ? (a + 1) % shown.length : 0))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => (shown.length ? (a - 1 + shown.length) % shown.length : 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const c = shown[active]
      if (c) {
        onClose()
        c.run()
      }
    } else if (e.key === "Tab") {
      e.preventDefault() // the box has one control; keep focus inside it while it is open
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]" style={{ background: "var(--cm-scrim)" }} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="cm-glass w-full max-w-lg overflow-hidden shadow-[var(--cm-pop-shadow)]"
        style={{ background: "var(--cm-glass-solid)" }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[active] ? `${listId}-${shown[active].id}` : undefined}
          aria-label="Search pages and actions"
          placeholder="Search pages and actions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border-b bg-transparent px-4 py-3.5 text-sm outline-none"
          style={{ borderColor: "var(--cm-border)", color: "var(--cm-text)" }}
        />
        <ul id={listId} role="listbox" aria-label="Results" className="max-h-72 overflow-auto p-1.5">
          {shown.length === 0 ? (
            <li className="px-3 py-3 text-sm" style={{ color: "var(--cm-muted)" }}>
              Nothing matches.
            </li>
          ) : (
            shown.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${c.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onClose()
                  c.run()
                }}
                className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm"
                style={i === active ? { background: "var(--cm-active-bg)", color: "var(--cm-active-ink)" } : undefined}
              >
                <span aria-hidden="true">{c.icon}</span>
                <span className="flex-1">{c.label}</span>
                {c.hint ? (
                  <span className="text-xs" style={{ color: "var(--cm-muted)" }}>
                    {c.hint}
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
