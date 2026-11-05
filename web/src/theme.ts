// HeroUI switches themes with a class and a data attribute on <html>. The page follows the system until the
// user picks a theme; the pick is remembered in this browser only (and everything still works if storage is blocked).
export type Theme = "light" | "dark"
const KEY = "cammut-theme"

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : null
  } catch {
    return null
  }
}

function paint(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark")
  document.documentElement.dataset.theme = t
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light"
}

export function initTheme(): void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  paint(stored() ?? (mq.matches ? "dark" : "light"))
  mq.addEventListener("change", () => {
    if (stored()) return
    paint(mq.matches ? "dark" : "light")
    window.dispatchEvent(new Event("cammut-theme"))
  })
}

export function setTheme(t: Theme): void {
  paint(t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* private window or blocked storage: the choice lasts until reload */
  }
  window.dispatchEvent(new Event("cammut-theme"))
}

export function toggleTheme(): void {
  setTheme(currentTheme() === "dark" ? "light" : "dark")
}
