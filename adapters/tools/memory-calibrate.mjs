#!/usr/bin/env node
// Calibrate the recall relevance gate on real data. Prints COUNTS ONLY: never a query, a note title, a note body or a key.
//
//   CAMMUT_URL=... CAMMUT_MEMORY_TOKEN=... node adapters/tools/memory-calibrate.mjs --queries <file.json> --project <name>
//
// <file.json> is the owner's own labelled list, kept outside the repository:
//   [{"q": "where does the build cache live", "expect": ["cammut.build-cache"]}, {"q": "recipe for tomato soup", "expect": []}]
// expect lists note keys (or ids) that a good answer contains; an empty list marks an off-topic query that must be answered
// with abstained=below_threshold. Exit 0 when no off-topic query was answered and every expected note came back; 1 otherwise;
// 2 on a usage error. Change CAMMUT_RECALL_GATE ("base,short,long") on the server, restart, run again, compare the counts.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// rows: [{expect: string[], notes: [{id, key}], abstained: string}]
export function summarize(rows) {
  const s = { queries: rows.length, onTopic: 0, offTopic: 0, onTopicAnswered: 0, onTopicAbstained: 0, expectedFound: 0, expectedTotal: 0,
    offTopicAbstained: 0, offTopicLeaked: 0, leakedQueries: [], returned: 0, relevantReturned: 0, hitCounts: {} };
  rows.forEach((r, i) => {
    const n = r.notes.length;
    s.returned += n;
    const bucket = n >= 3 ? '3+' : String(n);
    s.hitCounts[bucket] = (s.hitCounts[bucket] || 0) + 1;
    const ids = new Set(r.notes.flatMap((x) => [x.id, x.key].filter(Boolean)));
    if (r.expect.length === 0) {
      s.offTopic++;
      if (n === 0) s.offTopicAbstained++;
      else { s.offTopicLeaked++; s.leakedQueries.push(i + 1); }
      return;
    }
    s.onTopic++;
    if (n > 0) s.onTopicAnswered++; else s.onTopicAbstained++;
    for (const k of r.expect) { s.expectedTotal++; if (ids.has(k)) s.expectedFound++; }
    s.relevantReturned += r.notes.filter((x) => r.expect.includes(x.key) || r.expect.includes(x.id)).length;
  });
  return s;
}

export async function run({ argv = process.argv.slice(2), env = process.env, say = console.log } = {}) {
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const file = flag('--queries');
  const project = flag('--project');
  if (!file || !project || !env.CAMMUT_URL || !env.CAMMUT_MEMORY_TOKEN) {
    say('usage: CAMMUT_URL=... CAMMUT_MEMORY_TOKEN=... memory-calibrate.mjs --queries <file.json> --project <name>');
    return 2;
  }
  let queries;
  try { queries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { say('cannot read the queries file'); return 2; }
  if (!Array.isArray(queries) || queries.some((q) => typeof q?.q !== 'string' || !Array.isArray(q.expect))) { say('the queries file must be a list of {"q": string, "expect": [keys]}'); return 2; }
  const base = env.CAMMUT_URL.replace(/\/+$/, '');
  const rows = [];
  for (const q of queries) {
    const res = await fetch(`${base}/v1/memory/recall`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CAMMUT_MEMORY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: q.q, project, limit: 6 }), signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!res || !res.ok) { say(`recall failed (HTTP ${res ? res.status : 'network'}) at query #${rows.length + 1}`); return 1; }
    const j = await res.json().catch(() => ({}));
    rows.push({ expect: q.expect, notes: Array.isArray(j.notes) ? j.notes : [], abstained: j.abstained || '' });
  }
  const s = summarize(rows);
  say(`queries=${s.queries} on-topic=${s.onTopic} off-topic=${s.offTopic}`);
  say(`on-topic: answered=${s.onTopicAnswered} abstained=${s.onTopicAbstained}, expected notes found ${s.expectedFound}/${s.expectedTotal}, precision=${(s.relevantReturned / Math.max(1, s.returned)).toFixed(2)} over all returned notes`);
  say(`off-topic: abstained=${s.offTopicAbstained} leaked=${s.offTopicLeaked}${s.leakedQueries.length ? ` (query ${s.leakedQueries.map((i) => `#${i}`).join(', ')})` : ''}`);
  say(`hits per query: ${Object.entries(s.hitCounts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  return s.offTopicLeaked === 0 && s.expectedFound === s.expectedTotal ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run();
}
