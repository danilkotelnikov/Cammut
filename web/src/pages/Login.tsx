import { useEffect, useState, type FormEvent } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Button, Input, Label, TextField } from "@heroui/react"
import { api, ApiError } from "../api"
import { useAuth } from "../auth"
import { Banner } from "../components/Banner"
import { Scene, usePaletteVars } from "../components/Scene"
import { CubeCluster } from "../components/CubeCluster"
import { Wordmark } from "../brand/AsCube"
import { takeNext } from "../next"

export function explain(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "Wrong username, password or code."
    if (e.status === 429) return `Too many attempts. Try again in ${e.retryAfter ?? 60} s.`
    if (e.status === 503) return "The server is busy. Try again in a moment."
    if (e.status === 404) return "Sign-in is switched off on this address."
    return e.message
  }
  return "Could not reach the server."
}

/**
 * Authenticator apps show a code as "123 456". Cammut accepts exactly six digits, so a space typed or pasted from the app
 * made every sign-in fail. A code made only of digits and spaces is sent as six digits; anything else (a recovery code)
 * is sent as typed, trimmed, and the server cleans it.
 */
export function cleanCode(code: string): string {
  return /^[\d\s]+$/.test(code) ? code.replace(/\s+/g, "") : code.trim()
}

export function Login() {
  const nav = useNavigate()
  const { refresh } = useAuth()
  const [params] = useSearchParams()
  const githubStep = params.get("github") === "1"
  const [methods, setMethods] = useState<{ password: boolean; github: boolean } | null>(null)
  const [methodError, setMethodError] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(params.get("error") === "github" ? "GitHub sign-in did not work. Try again or use your password." : "")

  useEffect(() => {
    api.methods().then(setMethods).catch(() => setMethodError(true))
  }, [])

  // GitHub sign-in that needs no code ends here: the server already set the session cookie.
  const githubDone = params.get("github") === "done"
  useEffect(() => {
    if (githubDone) void refresh().then(() => nav(takeNext(), { replace: true }))
  }, [githubDone, refresh, nav])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      if (githubStep) await api.loginGithub(cleanCode(code))
      else await api.login(username, password, cleanCode(code))
      await refresh()
      nav(takeNext(), { replace: true })
    } catch (err) {
      setError(explain(err))
      setCode("")
    } finally {
      setBusy(false)
    }
  }

  const off = methods !== null && !methods.password && !methods.github
  // GitHub-only public mode: no password form at all, just the GitHub button (the code box comes after GitHub confirmed who you are)
  const githubOnly = methods !== null && !methods.password && methods.github && !githubStep
  const vars = usePaletteVars()

  return (
    <>
      <Scene variant="full" />
      <main className="mx-auto flex min-h-screen w-full max-w-[26rem] flex-col justify-center gap-4 px-4 pb-24 pt-8">
        <div className="flex justify-center" style={vars}>
          <div className="cm-badge">
            <CubeCluster size={92} />
          </div>
        </div>
        <section className="cm-glass flex flex-col gap-4 p-6 shadow-[var(--cm-pop-shadow)]" aria-labelledby="login-title">
          <div className="flex justify-center pb-1">
            <Wordmark size={48} />
          </div>
          <div>
            <h1 id="login-title" className="text-xl font-medium tracking-tight">
              {githubStep ? "Almost there" : "Sign in"}
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--cm-muted)" }}>
              {githubStep ? "GitHub confirmed who you are. Enter your authenticator code to finish." : "to your Cammut console"}
            </p>
          </div>
          {error ? <Banner title={error} /> : null}
          {methodError ? (
            <Banner title="Could not check how to sign in.">Check your connection and reload the page.</Banner>
          ) : methods === null ? (
            <p className="text-sm" style={{ color: "var(--cm-muted)" }}>
              Checking how to sign in…
            </p>
          ) : off ? (
            <Banner status="warning" title="Sign-in is switched off on this address.">
              <p>Owner-only access: forward the private console with <code className="mono">ssh -L 7422:127.0.0.1:7422 YOUR_SSH_HOST</code>, then open <code className="mono">http://cammut.localhost:7422/console/</code>.</p>
              <p className="mt-2">On a public address, sign-in stays off until the server runs with <code className="mono">-public-login</code> or <code className="mono">-public-login-github-only</code>. The setup guide explains when that is safe.</p>
            </Banner>
          ) : githubOnly ? (
            <div className="flex flex-col gap-3">
              <a
                href="/auth/github/start"
                className="w-full rounded-xl border px-4 py-2 text-center text-sm hover:bg-[var(--cm-hover)]"
                style={{ borderColor: "var(--cm-border-strong)" }}
              >
                Sign in with GitHub
              </a>
              <p className="text-xs" style={{ color: "var(--cm-muted)" }}>
                Only the GitHub account linked to this console can sign in.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              {githubStep ? null : (
                <>
                  <TextField isRequired name="username" value={username} onChange={setUsername}>
                    <Label>Username</Label>
                    <Input autoComplete="username" autoCapitalize="none" spellCheck={false} />
                  </TextField>
                  <TextField isRequired name="password" type="password" value={password} onChange={setPassword}>
                    <Label>Password</Label>
                    <Input autoComplete="current-password" />
                  </TextField>
                </>
              )}
              <TextField isRequired name="code" value={code} onChange={setCode}>
                <Label>Authenticator or recovery code</Label>
                <Input autoComplete="one-time-code" inputMode="text" autoCapitalize="none" spellCheck={false} />
                <p className="mt-1 text-xs" style={{ color: "var(--cm-muted)" }}>
                  The six digits from your app (a space in the middle is fine), or one recovery code.
                </p>
              </TextField>
              <Button type="submit" isPending={busy} className="w-full">
                {githubStep ? "Finish sign-in" : "Sign in"}
              </Button>
              {methods?.github && !githubStep ? (
                <a
                  href="/auth/github/start"
                  className="w-full rounded-xl border px-4 py-2 text-center text-sm hover:bg-[var(--cm-hover)]"
                  style={{ borderColor: "var(--cm-border-strong)" }}
                >
                  Sign in with GitHub
                </a>
              ) : null}
            </form>
          )}
        </section>
      </main>
    </>
  )
}
