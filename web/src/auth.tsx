import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { api, setOnUnauthorized } from "./api"

export type User = { username: string; github_linked: boolean }
type Ctx = { user: User | null | undefined; refresh: () => Promise<void>; logout: () => Promise<void> }

export const AuthContext = createContext<Ctx>({ user: undefined, refresh: async () => {}, logout: async () => {} })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me())
    } catch {
      setUser(null)
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    setOnUnauthorized(() => setUser(null)) // a session that dies mid-use sends the user to the login page
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ user, refresh, logout }), [user, refresh, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): Ctx {
  return useContext(AuthContext)
}
