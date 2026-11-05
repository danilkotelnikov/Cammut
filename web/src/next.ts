// Where to go after signing in. It is kept in sessionStorage so it survives the page changes of the sign-in,
// including the round trip to GitHub. Only paths inside the console are ever stored or used.
const KEY = "cammut-next"

export function rememberNext(path: string): void {
  try {
    if (path.startsWith("/") && !path.startsWith("//") && path !== "/" && path !== "/servers" && path !== "/login") sessionStorage.setItem(KEY, path)
  } catch {
    // a blocked sessionStorage only means the sign-in lands on the start page
  }
}

export function takeNext(): string {
  try {
    const v = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (v && v.startsWith("/") && !v.startsWith("//") && !v.includes("://")) return v
  } catch {
    // see above
  }
  return "/servers"
}
