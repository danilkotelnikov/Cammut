export const enc = new TextEncoder();

export function b64u(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(bytes = 32): string {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const esc = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
