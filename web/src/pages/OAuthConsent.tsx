import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Button } from "@heroui/react"
import { api, ApiError, type OAuthRequest } from "../api"
import { Banner } from "../components/Banner"
import { Wordmark } from "../brand/AsCube"

/** The owner answers an app's request to connect. The app's one-time code travels only in the address this page sends the browser to. */
export function OAuthConsent() {
  const [params] = useSearchParams()
  const req = params.get("req") ?? ""
  const [info, setInfo] = useState<OAuthRequest | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!req) return setError("This page needs a connection request. Start again from the app.")
    api.oauth
      .request(req)
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "This request has expired or was already answered. Start again from the app." : "Could not load the request."))
  }, [req])

  async function answer(yes: boolean) {
    setBusy(true)
    try {
      const r = yes ? await api.oauth.approve(req) : await api.oauth.deny(req)
      window.location.assign(r.redirect)
    } catch {
      setError("Could not send the answer. Start again from the app.")
      setBusy(false)
    }
  }

  return (
    <main className="cm-glass mx-auto mt-16 flex max-w-md flex-col gap-4 rounded-2xl p-6">
      <Wordmark />
      <h1 className="text-xl font-semibold tracking-tight">Connect an app</h1>
      {error ? <Banner title={error} /> : null}
      {info ? (
        <>
          <p className="text-sm">
            <strong>{info.client_name}</strong> wants to use your Cammut. It will send you back to <span className="mono">{info.redirect_host}</span>.
          </p>
          <div>
            <p className="mb-1 text-xs opacity-70">It will be allowed to use</p>
            <ul className="mono flex flex-col gap-1 text-sm">
              {info.scopes.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs opacity-70">The connection stays until you end it on the Apps page. You will not be asked to sign in again.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" isDisabled={busy} onPress={() => void answer(false)}>
              Deny
            </Button>
            <Button isPending={busy} onPress={() => void answer(true)}>
              Allow
            </Button>
          </div>
        </>
      ) : null}
    </main>
  )
}
