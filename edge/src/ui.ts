import { esc } from "./util.ts";
import { scopeLabel } from "./scopes.ts";

/** One constant for the product name. */
export const PRODUCT = "Arc Science";

// ---- cube logo (from the approved C2 preview): one colour, letters on one face ----
const TOP = "M128.00 18.80L220.15 72.00L128.00 125.20L35.85 72.00Z";
const L_PLAIN = "M33.43 76.20L125.58 129.40L125.58 235.80L33.43 182.60Z";
const R_PLAIN = "M130.42 129.40L222.57 76.20L222.57 182.60L130.42 235.80Z";
const L_TEXT =
  "M33.43 76.20L125.58 129.40L125.58 235.80L33.43 182.60ZM43.61 161.18L54.83 115.85L65.30 121.90L76.51 180.17L67.54 174.99L64.92 161.40L55.20 155.78L52.59 166.36ZM60.06 136.14L63.05 151.68L57.07 148.23ZM82.49 131.83L109.41 147.37L115.39 157.73L115.39 161.18L91.47 147.37L91.47 157.73L115.39 171.54L115.39 202.62L88.47 187.08L82.49 176.72L82.49 173.27L106.42 187.08L106.42 176.72L82.49 162.91Z";
const R_TEXT =
  "M130.42 129.40L222.57 76.20L222.57 182.60L130.42 235.80ZM140.61 202.62L151.82 144.34L162.29 138.30L173.51 183.63L164.53 188.81L161.92 178.23L152.20 183.84L149.58 197.44ZM157.06 158.59L160.05 170.68L154.07 174.13ZM179.49 128.37L206.40 112.83L212.39 116.29L212.39 119.74L188.46 133.55L188.46 143.91L212.39 130.10L212.39 161.18L185.47 176.72L179.49 173.27L179.49 169.81L203.41 156.00L203.41 145.64L179.49 159.45Z";

const svg = (cls: string, d: string) =>
  `<svg class="${cls}" viewBox="0 0 256 256" aria-hidden="true"><path fill-rule="evenodd" d="${d}"/></svg>`;

/** Two faces stacked; the CSS turn (620 ms) swaps them at the narrowest point. */
export const cube = (size: number) =>
  `<span class="cube" style="--s:${size}px" role="img" aria-label="${PRODUCT}">` +
  svg("fl", `${TOP}${L_TEXT}${R_PLAIN}`) +
  svg("fr", `${TOP}${L_PLAIN}${R_TEXT}`) +
  `</span>`;

const GH =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'; // privacy-scan: allow
const GOOGLE =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.2 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.9 3.2 14.8 2.2 12.2 2.2 7 2.2 2.8 6.4 2.8 11.6s4.2 9.4 9.4 9.4c5.4 0 9-3.8 9-9.2 0-.6-.1-1.1-.2-1.6h-8.8z"/></svg>';

// C2 tokens, light and dark, system font stack (keeps the Worker small).
const CSS = `
:root{--bg:#faf9f6;--surface:#fff;--surface-2:#f5f3ee;--border:#e6e2da;--border-strong:#d2cdc2;--text:#26231f;--text-2:#4b463f;--muted:#645e55;--hover:#26231f0f;--accent:#54453c;--accent-hover:#6a574b;--on-accent:#fff;--focus:#3c66bc;--warn-bg:#f3f0eb;--warn-bd:#d8cec0;--ink:#0a0a0a;--radius:10px;--r-ctl:8px;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"Cascadia Mono",Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--surface:#1f1e1b;--surface-2:#272522;--border:#302e2a;--border-strong:#47443e;--text:#f0eee9;--text-2:#cfcac1;--muted:#a8a298;--hover:#f0eee914;--accent:#e8e1d6;--accent-hover:#fff;--on-accent:#26231f;--focus:#8fb0ee;--warn-bg:#272522;--warn-bd:#47443e;--ink:#f0f0f5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.55 var(--font);-webkit-font-smoothing:antialiased;min-height:100vh;display:grid;place-items:center;padding:24px 16px}
h1{font-size:21px;line-height:1.25;font-weight:600;letter-spacing:-.02em;margin:0}
p{margin:0}
.card{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 1px 2px #26231f0d;padding:24px;display:flex;flex-direction:column;gap:16px;animation:rise .5s cubic-bezier(.05,.7,.1,1) both}
.card.wide{max-width:520px}
.card.admin{max-width:760px}
.head{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.muted{color:var(--muted)}.fine{color:var(--muted);font-size:13px}
.mono{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border-radius:var(--r-ctl);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:500 14px/1 var(--font);cursor:pointer;text-decoration:none}
.btn:hover{background:var(--surface-2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
.btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.lg{height:50px;font-size:16px;border-radius:10px}
.btn.sm{height:30px;padding:0 10px;font-size:13px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.row{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.scopes{display:flex;flex-direction:column;gap:8px}
.scope{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--border);border-radius:var(--r-ctl);background:var(--surface-2);padding:10px 12px;cursor:pointer}
.scope input{margin-top:4px;accent-color:var(--accent)}
.scope b{display:block;font-weight:600}
.note{border:1px solid var(--warn-bd);background:var(--warn-bg);border-radius:var(--r-ctl);padding:10px 12px;font-size:14px}
.err{border:1px solid var(--border-strong);border-radius:var(--r-ctl);padding:10px 12px;font-size:14px}
label.f{display:flex;flex-direction:column;gap:6px;font-weight:500;font-size:14px}
input[type=text],textarea{font:400 14px/1.4 var(--font);color:var(--text);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-ctl);padding:9px 10px;width:100%}
textarea{min-height:84px;font-family:var(--mono);font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--border);vertical-align:top;word-break:break-word}
th{color:var(--muted);font-weight:500;font-size:13px;border-top:0}
code{font-family:var(--mono);font-size:12.5px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:1px 6px;word-break:break-all}
.cube{--s:56px;position:relative;display:block;flex:none;width:var(--s);height:var(--s);color:var(--ink);animation:turn .62s ease-in-out both}
.cube svg{position:absolute;inset:0;width:100%;height:100%;fill:currentColor}
.cube .fr{animation:hideR .62s both}
.cube .fl{animation:showL .62s both}
@keyframes turn{0%{transform:scaleX(1)}45%{transform:scaleX(.03)}80%{transform:translateY(3px) scaleX(1)}100%{transform:none}}
@keyframes hideR{0%,44.9%{opacity:1}45%,100%{opacity:0}}
@keyframes showL{0%,44.9%{opacity:0}45%,100%{opacity:1}}
@keyframes rise{0%{opacity:0;transform:translateY(18px)}100%{opacity:1;transform:none}}
@keyframes fade{0%{opacity:0}100%{opacity:1}}
@media (prefers-reduced-motion:reduce){.cube,.cube .fl,.cube .fr{animation:none}.cube .fr{opacity:0}.cube .fl{opacity:1}.card{animation:fade .15s linear both}}
@media (max-width:420px){.card{padding:20px 16px}}
`;

export interface PageOpts {
  status?: number;
  /** Extra form-action sources, e.g. the client's redirect origin (Chrome applies form-action to redirects). */
  formAction?: string[];
  headers?: HeadersInit;
}

export function html(env: { APPWRITE_ENDPOINT: string }, title: string, body: string, o: PageOpts = {}): Response {
  const aw = new URL(env.APPWRITE_ENDPOINT).origin;
  const fa = ["'self'", aw, ...(o.formAction ?? [])].join(" ");
  const h = new Headers(o.headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action ${fa}; frame-ancestors 'none'; base-uri 'none'`,
  );
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)} · ${PRODUCT}</title><style>${CSS}</style></head><body>${body}</body></html>`;
  return new Response(doc, { status: o.status ?? 200, headers: h });
}

export function signInPage(env: { APPWRITE_ENDPOINT: string }, urls: { github: string; google?: string }, heading: string, extraHeaders?: HeadersInit) {
  return html(
    env,
    "Sign in",
    `<main class="card"><div class="head">${cube(56)}<h1>${esc(heading)}</h1></div>
<p class="muted">Use the account you already have.</p>
<a class="btn primary lg" href="${esc(urls.github)}">${GH}Continue with GitHub</a>
${urls.google ? `<a class="btn lg" href="${esc(urls.google)}">${GOOGLE}Continue with Google</a>` : ""}
<p class="fine">Only the owner of this server can continue.</p></main>`,
    { headers: extraHeaders },
  );
}

/**
 * After the consent form: a page that moves on to the app. A redirect answering the form POST falls under
 * form-action for every hop, and some relays (Gemini's oauth-redirect.googleusercontent.com) hop on to hosts
 * we cannot list, so the browser drops the code and the app never calls /token. A meta refresh is a new
 * navigation, not a form submission.
 */
export function handoffPage(env: { APPWRITE_ENDPOINT: string }, to: string, extraHeaders?: HeadersInit) {
  const u = esc(to);
  return html(
    env,
    "Returning to the app",
    `<meta http-equiv="refresh" content="0;url=${u}"><main class="card"><div class="head">${cube(44)}<h1>Returning to the app</h1></div><p class="muted">If nothing happens, <a href="${u}">continue</a>.</p></main>`,
    { headers: extraHeaders },
  );
}

export function messagePage(env: { APPWRITE_ENDPOINT: string }, status: number, heading: string, text: string, extraHeaders?: HeadersInit) {
  return html(
    env,
    heading,
    `<main class="card"><div class="head">${cube(44)}<h1>${esc(heading)}</h1></div><p class="muted">${esc(text)}</p></main>`,
    { status, headers: extraHeaders },
  );
}

export interface ConsentView {
  appName: string;
  redirectHost: string;
  loopback: boolean;
  scopes: { value: string; checked: boolean }[];
  who: string;
  csrf: string;
  formAction: string;
  error?: string;
}

export function consentPage(env: { APPWRITE_ENDPOINT: string }, v: ConsentView) {
  const boxes = v.scopes
    .map(
      (s) =>
        `<label class="scope"><input type="checkbox" name="scope" value="${esc(s.value)}"${s.checked ? " checked" : ""}><span><b>${esc(scopeLabel(s.value))}</b><span class="mono">${esc(s.value)}</span></span></label>`,
    )
    .join("");
  return html(
    env,
    "Connect an app",
    `<main class="card wide"><div class="head">${cube(44)}<h1>${esc(v.appName)} wants to use your tools and memory</h1></div>
<p class="muted">It will send you back to <span class="mono">${esc(v.redirectHost)}</span> after you answer.</p>
${v.loopback ? '<p class="note">This sends access to an app on your own computer. Continue only if you just started it.</p>' : ""}
${v.error ? `<p class="err">${esc(v.error)}</p>` : ""}
<form method="post" action="/auth/consent" style="display:contents">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">
<div class="scopes" role="group" aria-label="Requested access">${boxes}</div>
<p class="fine">Signed in as ${esc(v.who)}. The connection stays until you end it.</p>
<div class="row"><button class="btn" name="decision" value="deny" type="submit">Deny</button><button class="btn primary" name="decision" value="allow" type="submit">Allow</button></div>
</form></main>`,
    { formAction: [v.formAction], status: v.error ? 400 : 200 },
  );
}

export interface AdminClient {
  id: string;
  name: string;
  method: string;
  redirects: string[];
}

export function adminPage(
  env: { APPWRITE_ENDPOINT: string },
  v: { csrf: string; clients: AdminClient[]; created?: { id: string; secret: string; name: string }; error?: string },
  status = 200,
) {
  const rows = v.clients
    .map(
      (c) =>
        `<tr><td>${esc(c.name || "(no name)")}<br><code>${esc(c.id)}</code></td><td>${esc(c.method)}</td><td>${c.redirects.map((r) => `<code>${esc(r)}</code>`).join("<br>")}</td><td><form method="post" action="/admin/clients/delete"><input type="hidden" name="csrf" value="${esc(v.csrf)}"><input type="hidden" name="client_id" value="${esc(c.id)}"><button class="btn sm" type="submit">Delete</button></form></td></tr>`,
    )
    .join("");
  const created = v.created
    ? `<div class="note"><b>${esc(v.created.name)}</b> is ready. Copy the secret now; it is shown once.<br>Client ID <code>${esc(v.created.id)}</code><br>Client secret <code>${esc(v.created.secret)}</code><br><span class="fine">Token endpoint auth: client_secret_post.</span></div>`
    : "";
  return html(
    env,
    "Clients",
    `<main class="card admin"><div class="head">${cube(44)}<h1>Connected apps and manual clients</h1></div>
${v.error ? `<p class="err">${esc(v.error)}</p>` : ""}${created}
<table><thead><tr><th>Client</th><th>Auth</th><th>Redirect URIs</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No clients yet.</td></tr>'}</tbody></table>
<form method="post" action="/admin/clients/create" style="display:flex;flex-direction:column;gap:12px">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">
<h1 style="font-size:17px">New manual client (Gemini)</h1>
<label class="f">Name<input type="text" name="name" value="Gemini" maxlength="80" required></label>
<label class="f">Redirect URIs, one per line<textarea name="redirect_uris" required></textarea></label>
<div class="row"><button class="btn primary" type="submit">Create client</button></div>
</form></main>`,
    { status },
  );
}
