// Tiny fetch wrapper shared by the maintenance tools. The key comes from the environment only and is never printed.
// Returns {status, json}; a transport failure is {status: 0, json: null, error: <error name>}.
export const makeClient = ({ urlEnv, urlDefault, keyEnv, env = process.env }) => async (method, path, body, ms = 60000) => {
  const key = env[keyEnv];
  if (!key) throw new Error(`${keyEnv} MISSING`);
  try {
    const res = await fetch((env[urlEnv] || urlDefault) + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: null, error: e?.name || 'network' };
  }
};

// Hindsight; SM_HS_URL and the key are read at call time.
export const hs = (method, path, body, ms) => makeClient({ urlEnv: 'SM_HS_URL', urlDefault: 'http://127.0.0.1:8888', keyEnv: 'SHARED_MEMORY_HINDSIGHT_API_KEY' })(method, path, body, ms);

// Counts and key names of a JSON value, never string contents: numbers and booleans stay, strings become their
// length, arrays their length, objects recurse (depth-limited).
export function shape(v, depth = 3) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return { chars: v.length };
  if (Array.isArray(v)) return { len: v.length };
  if (depth <= 0) return { keys: Object.keys(v).length };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth - 1)]));
}
