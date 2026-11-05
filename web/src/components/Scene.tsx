import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react"
import { currentTheme } from "../theme"
import { DEFAULT_PALETTE, PALETTES, paletteVars, type Theme } from "./palettes"
import { DEFAULT_LAYOUT, DEFAULT_PICTURE, PICTURES } from "./pictures"

// The background: a picture (cube pattern, soft colour or park) in a palette (black and white, original, dusk, dawn or sage).
// On the login page Space randomises: a new palette and, for the cube pattern, a new layout, as on the v0 generator.
// P (or its chip) brings another picture. Palette and picture are remembered in this browser. Inside the app the picture is
// faint and "Change palette" and "Change picture" in the Ctrl+K box do the same. The seven-cube mark on the login page
// reads the same palette.

export const SHUFFLE_EVENT = "cammut-shuffle" // randomise: another palette (and another cube layout)
export const PICTURE_EVENT = "cammut-picture" // another picture
const PALETTE_KEY = "cammut-palette"
const PICTURE_KEY = "cammut-picture"

function stored(key: string, allowed: string[], fallback: string): string {
  try {
    const v = localStorage.getItem(key)
    if (v && allowed.includes(v)) return v
  } catch {
    /* storage blocked */
  }
  return fallback
}

// one shared choice for each, so everything drawn from them changes together
function makeStore<T extends string | number>(initial: T, persistKey?: string) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      if (persistKey) {
        try {
          localStorage.setItem(persistKey, String(next))
        } catch {
          /* storage blocked: the choice lasts until reload */
        }
      }
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    use() {
      return useSyncExternalStore(this.subscribe, this.get, () => initial)
    },
  }
}

const paletteStore = makeStore<string>(
  stored(PALETTE_KEY, PALETTES.map((p) => p.name), DEFAULT_PALETTE),
  PALETTE_KEY,
)
const pictureStore = makeStore<string>(
  stored(PICTURE_KEY, PICTURES.map((p) => p.name), DEFAULT_PICTURE),
  PICTURE_KEY,
)
const layoutStore = makeStore<number>(DEFAULT_LAYOUT) // not remembered: each visit starts from the default layout

export const setPalette = (name: string) => paletteStore.set(name)
export const setPicture = (name: string) => pictureStore.set(name)
export const setLayout = (seed: number) => layoutStore.set(seed)
export const usePaletteName = () => paletteStore.use()
export const usePictureName = () => pictureStore.use()
export const useLayout = () => layoutStore.use()

/** Another name than the current one, chosen from `rand` (0 up to 1). */
export function pickOther(names: string[], cur: string, rand: number): string {
  const others = names.filter((n) => n !== cur)
  return others[Math.min(others.length - 1, Math.floor(rand * others.length))]
}
export const nextPalette = (cur: string, rand: number) => pickOther(PALETTES.map((p) => p.name), cur, rand)
export const nextPicture = (cur: string, rand: number) => pickOther(PICTURES.map((p) => p.name), cur, rand)

const random = () => {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] / 4294967296
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(t.tagName) || t.closest('[role="dialog"],[role="menu"],[role="listbox"]') !== null
}

function useThemeName(): Theme {
  const [t, setT] = useState<Theme>(currentTheme())
  useEffect(() => {
    const on = () => setT(currentTheme())
    window.addEventListener("cammut-theme", on)
    return () => window.removeEventListener("cammut-theme", on)
  }, [])
  return t
}

/** The variables of the current palette, for pieces drawn outside <Scene>, such as the seven-cube mark. */
export function usePaletteVars(): CSSProperties {
  const name = usePaletteName()
  const theme = useThemeName()
  return useMemo(() => paletteVars(PALETTES.find((p) => p.name === name) ?? PALETTES[0], theme) as CSSProperties, [name, theme])
}

export function Scene({ variant = "full" }: { variant?: "full" | "quiet" }) {
  const paletteName = usePaletteName()
  const pictureName = usePictureName()
  const layout = useLayout()
  const vars = usePaletteVars()
  const palette = PALETTES.find((p) => p.name === paletteName) ?? PALETTES[0]
  const picture = PICTURES.find((p) => p.name === pictureName) ?? PICTURES[0]

  const randomise = useCallback(() => {
    setPalette(nextPalette(paletteStore.get(), random()))
    setLayout(Math.floor(random() * 4294967296))
  }, [])
  const changePicture = useCallback(() => setPicture(nextPicture(pictureStore.get(), random())), [])

  useEffect(() => {
    window.addEventListener(SHUFFLE_EVENT, randomise)
    window.addEventListener(PICTURE_EVENT, changePicture)
    return () => {
      window.removeEventListener(SHUFFLE_EVENT, randomise)
      window.removeEventListener(PICTURE_EVENT, changePicture)
    }
  }, [randomise, changePicture])

  useEffect(() => {
    if (variant !== "full") return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTyping(e.target)) return
      if (e.code === "Space") {
        e.preventDefault()
        randomise()
      } else if (e.code === "KeyP") {
        e.preventDefault()
        changePicture()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [variant, randomise, changePicture])

  const Art = picture.Art
  return (
    <>
      <div className="cm-sky" aria-hidden="true" data-palette={palette.name} data-picture={picture.name} data-layout={layout} style={vars}>
        <div className="cm-picture" style={{ opacity: variant === "full" ? 1 : 0.3 }}>
          <Art palette={palette} layout={layout} />
        </div>
        {/* a veil in the page colour keeps the picture calm behind the panels */}
        <div className="absolute inset-0" style={{ background: "var(--cm-bg)", opacity: variant === "full" ? 0.22 : 0 }} />
      </div>
      {variant === "full" ? (
        <div className="fixed bottom-4 left-1/2 z-10 flex -translate-x-1/2 gap-2">
          <button type="button" onClick={randomise} className="cm-chip cursor-pointer hover:brightness-105" aria-label="Change the palette">
            {palette.label} <kbd className="cm-kbd">Space</kbd>
          </button>
          <button type="button" onClick={changePicture} className="cm-chip cursor-pointer hover:brightness-105" aria-label="Change the picture">
            {picture.label} <kbd className="cm-kbd">P</kbd>
          </button>
        </div>
      ) : null}
    </>
  )
}
