// Hindsight recall controls shared by the adapters: ask for observations first, name the fact types, set a score floor,
// and degrade to the plain request if the server does not know the new fields. The live server accepts `types`,
// `prefer_observations` and `min_scores` (confirmed from its tool schema 2026-10-17); a different version may not.
//
// min_scores is an object of inclusive floors: semantic and keyword prune inside their own arm; reranker and final
// are post-ranking filters (the reranker's absolute scores are not calibrated across queries, so semantic is the default).

export const FACT_TYPES = ['observation', 'world', 'experience'];
export const DEFAULT_MIN_SCORES = { semantic: 0.3 };
const FLOORS = ['semantic', 'keyword', 'reranker', 'final'];
const DEGRADED_MS = 10 * 60 * 1000;

let degradedUntil = 0;
export const resetDegraded = () => { degradedUntil = 0; };

// opts.minScores: object of floors, {} = none. opts.preferObservations defaults to true.
export function recallBody(query, opts = {}) {
  const { maxTokens = 800, budget = 'mid', minScores = DEFAULT_MIN_SCORES, preferObservations = true, types = FACT_TYPES } = opts;
  const body = { query, budget, max_tokens: maxTokens, types };
  if (preferObservations) body.prefer_observations = true;
  if (minScores && Object.keys(minScores).length) body.min_scores = { ...minScores };
  return body;
}

// "semantic=0.3,final=0.1" or {"reranker":0.002}; "" = no floor; undefined = the default. Throws on anything else.
export function parseMinScores(s) {
  if (s === undefined || s === null) return DEFAULT_MIN_SCORES;
  const text = String(s).trim();
  if (text === '') return {};
  let obj;
  if (text.startsWith('{') || text.startsWith('[')) {
    try { obj = JSON.parse(text); } catch { throw new Error('min_scores: not valid JSON'); }
  } else {
    obj = {};
    for (const part of text.split(',')) {
      const [k, v] = part.split('=').map((x) => x.trim());
      obj[k] = v === undefined || v === '' ? NaN : Number(v);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('min_scores: expected an object of floors');
  for (const [k, v] of Object.entries(obj)) {
    if (!FLOORS.includes(k)) throw new Error(`min_scores: unknown floor "${k}" (use ${FLOORS.join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`min_scores: ${k} must be a number between 0 and 1`);
  }
  return obj;
}

const plain = (body) => { const { prefer_observations, min_scores, ...rest } = body; return rest; };
const strict = (body) => body.prefer_observations !== undefined || body.min_scores !== undefined;

// send(body) -> {ok, status, json}. A 400 or 422 on a request that carries the new controls means the server does not
// know them: retry once without, and skip the strict form for ten minutes. Anything else is returned as it is.
export async function recallWithFallback(send, body, now = Date.now()) {
  if (!strict(body)) return send(body);
  if (now < degradedUntil) return send(plain(body));
  const r = await send(body);
  if (r.ok || (r.status !== 400 && r.status !== 422)) return r;
  degradedUntil = now + DEGRADED_MS;
  return send(plain(body));
}
