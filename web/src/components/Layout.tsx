import { useEffect, useMemo, useState, type ReactNode } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import { useAuth } from "../auth"
import { Mark, Wordmark } from "../brand/Mark"
import { toggleTheme, currentTheme } from "../theme"
import { CommandPalette, type Command } from "./CommandPalette"
import { PICTURE_EVENT, Scene, SHUFFLE_EVENT } from "./Scene"
import { AppsIcon, KeyIcon, ListIcon, LogoutIcon, MemoryIcon, MenuIcon, MoonIcon, PlugIcon, SearchIcon, ServerIcon, ShuffleIcon, SunIcon } from "./icons"

const links: { to: string; label: string; icon: ReactNode }[] = [
  { to: "/servers", label: "Servers", icon: <ServerIcon /> },
  { to: "/tokens", label: "Tokens", icon: <KeyIcon /> },
  { to: "/memory", label: "Memory", icon: <MemoryIcon /> },
  { to: "/apps", label: "Apps", icon: <AppsIcon /> },
  { to: "/agent-setup", label: "Agent setup", icon: <PlugIcon /> },
  { to: "/audit", label: "Audit", icon: <ListIcon /> },
]

function useTheme() {
  const [theme, setT] = useState(currentTheme())
  useEffect(() => {
    const on = () => setT(currentTheme())
    window.addEventListener("cammut-theme", on)
    return () => window.removeEventListener("cammut-theme", on)
  }, [])
  return theme
}

function NavItems({ onPick }: { onPick?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          onClick={onPick}
          className="flex items-center gap-3 rounded-xl border px-3 py-2 text-sm"
          style={({ isActive }) =>
            isActive
              ? { background: "var(--cm-active-bg)", borderColor: "var(--cm-active-bd)", color: "var(--cm-active-ink)" }
              : { borderColor: "transparent", color: "var(--cm-text-2)" }
          }
        >
          {l.icon}
          {l.label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout() {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const theme = useTheme()
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)

  useEffect(() => setMenu(false), [loc.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((p) => !p)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const commands = useMemo<Command[]>(
    () => [
      ...links.map((l) => ({ id: "go-" + l.to.slice(1), label: l.label, hint: "Go to", icon: l.icon, run: () => nav(l.to) })),
      { id: "theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", hint: "Appearance", icon: theme === "dark" ? <SunIcon /> : <MoonIcon />, run: toggleTheme },
      { id: "shuffle", label: "Change palette", hint: "Appearance", icon: <ShuffleIcon />, run: () => window.dispatchEvent(new Event(SHUFFLE_EVENT)) },
      { id: "picture", label: "Change picture", hint: "Appearance", icon: <ShuffleIcon />, run: () => window.dispatchEvent(new Event(PICTURE_EVENT)) },
      { id: "logout", label: "Sign out", hint: "Account", icon: <LogoutIcon />, run: () => void logout() },
    ],
    [nav, theme, logout],
  )

  const themeButton = (
    <button type="button" onClick={toggleTheme} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-[var(--cm-hover)]" style={{ color: "var(--cm-text-2)" }}>
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      {theme === "dark" ? "Light theme" : "Dark theme"}
    </button>
  )

  return (
    <>
      <Scene variant="quiet" />
      <div className="flex min-h-screen">
        <aside
          className="sticky top-0 hidden h-screen w-[15.75rem] shrink-0 flex-col gap-4 border-r p-4 md:flex"
          style={{ background: "var(--cm-sidebar)", borderColor: "var(--cm-border)", backdropFilter: "blur(16px) saturate(1.2)", WebkitBackdropFilter: "blur(16px) saturate(1.2)" }}
        >
          <div className="px-1 pt-1">
            <Wordmark size={34} />
          </div>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm"
            style={{ borderColor: "var(--cm-border-strong)", color: "var(--cm-muted)", background: "var(--cm-chip-bg)" }}
            aria-label="Open command palette"
          >
            <SearchIcon />
            <span className="flex-1">Search</span>
            <kbd className="cm-kbd">Ctrl</kbd>
            <kbd className="cm-kbd">K</kbd>
          </button>
          <NavItems />
          <div className="mt-auto flex flex-col gap-1">
            {themeButton}
            <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--cm-border)", background: "var(--cm-chip-bg)" }}>
              <span className="truncate" style={{ color: "var(--cm-text-2)" }}>
                {user?.username}
              </span>
              <button type="button" onClick={() => void logout()} className="flex items-center gap-1.5 hover:underline" aria-label="Sign out">
                <LogoutIcon />
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 py-2.5 md:hidden" style={{ background: "var(--cm-sidebar)", borderColor: "var(--cm-border)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}>
            <span className="flex items-center gap-2" style={{ color: "var(--logo-ink)" }}>
              <Mark size={30} />
              <span className="font-semibold tracking-tight">Cammut</span>
            </span>
            <span className="flex items-center gap-1">
              <button type="button" onClick={() => setPalette(true)} aria-label="Open command palette" className="rounded-xl p-2 hover:bg-[var(--cm-hover)]">
                <SearchIcon />
              </button>
              <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="mobile-menu" aria-label="Menu" className="rounded-xl p-2 hover:bg-[var(--cm-hover)]">
                <MenuIcon />
              </button>
            </span>
          </header>
          {menu ? (
            <div id="mobile-menu" className="cm-glass m-3 flex flex-col gap-2 p-3 md:hidden" style={{ background: "var(--cm-glass-solid)" }}>
              <NavItems onPick={() => setMenu(false)} />
              {themeButton}
              <button type="button" onClick={() => void logout()} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-[var(--cm-hover)]">
                <LogoutIcon />
                Sign out {user?.username ? `(${user.username})` : ""}
              </button>
            </div>
          ) : null}
          <main className="mx-auto w-full max-w-6xl flex-1 p-3 md:p-6">
            <div className="cm-glass p-4 md:p-6" style={{ background: "var(--cm-glass)" }}>
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
    </>
  )
}
