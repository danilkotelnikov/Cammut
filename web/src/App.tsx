import type { ReactNode } from "react"
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { AuthProvider, useAuth } from "./auth"
import { Layout } from "./components/Layout"
import { rememberNext } from "./next"
import { Apps } from "./pages/Apps"
import { Audit } from "./pages/Audit"
import { AgentSetup } from "./pages/AgentSetup"
import { Login } from "./pages/Login"
import { Memory } from "./pages/Memory"
import { OAuthConsent } from "./pages/OAuthConsent"
import { Servers } from "./pages/Servers"
import { Tokens } from "./pages/Tokens"

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const here = useLocation()
  if (user === undefined) return <p className="p-6 opacity-70">Loading…</p>
  if (user === null) {
    rememberNext(here.pathname + here.search)
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export function App() {
  return (
    <BrowserRouter basename="/console">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth" element={<RequireAuth><OAuthConsent /></RequireAuth>} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Navigate to="/servers" replace />} />
            <Route path="servers" element={<Servers />} />
            <Route path="tokens" element={<Tokens />} />
            <Route path="memory" element={<Memory />} />
            <Route path="apps" element={<Apps />} />
            <Route path="agent-setup" element={<AgentSetup />} />
            <Route path="audit" element={<Audit />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
