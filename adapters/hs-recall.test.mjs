import test from 'node:test';
import assert from 'node:assert/strict';
import { recallBody, parseMinScores, recallWithFallback, resetDegraded, DEFAULT_MIN_SCORES } from './hs-recall.mjs';
import { fakeServer } from './test-helpers.mjs';

const post = (url, body) => fetch(url + '/v1/default/banks/b/memories/recall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));

test('recallBody asks for observations first, the three fact types and a score floor', () => {
  const b = recallBody('what is deployed');
  assert.deepEqual(b, { query: 'what is deployed', budget: 'mid', max_tokens: 800, types: ['observation', 'world', 'experience'], prefer_observations: true, min_scores: DEFAULT_MIN_SCORES });
  assert.deepEqual(DEFAULT_MIN_SCORES, { semantic: 0.3 });
});

test('recallBody takes overrides and an empty floor disables min_scores', () => {
  const b = recallBody('q', { maxTokens: 400, budget: 'low', minScores: { reranker: 0.01, final: 0.2 }, preferObservations: false });
  assert.deepEqual([b.max_tokens, b.budget, b.min_scores, b.prefer_observations], [400, 'low', { reranker: 0.01, final: 0.2 }, undefined]);
  assert.equal('min_scores' in recallBody('q', { minScores: {} }), false);
});

test('parseMinScores reads key=value pairs or JSON and refuses anything else', () => {
  assert.deepEqual(parseMinScores('semantic=0.3,final=0.1'), { semantic: 0.3, final: 0.1 });
  assert.deepEqual(parseMinScores('{"reranker":0.002}'), { reranker: 0.002 });
  assert.deepEqual(parseMinScores(''), {});
  assert.equal(parseMinScores(undefined), DEFAULT_MIN_SCORES);
  for (const bad of ['semantic=abc', 'bogus=0.3', 'semantic=2', '{"semantic":"x"}', '[1]']) assert.throws(() => parseMinScores(bad), /min_scores/, bad);
});

test('a server that rejects the new controls is asked again without them, once, and remembered for a while', async () => {
  resetDegraded();
  const hs = await fakeServer((c) => (c.body.prefer_observations !== undefined || c.body.min_scores !== undefined
    ? { status: 422, json: { detail: 'extra fields not permitted' } }
    : { status: 200, json: { results: [{ id: 'r1', text: 'a fact' }] } }));
  const send = (body) => post(hs.url, body);
  const r = await recallWithFallback(send, recallBody('q'));
  assert.equal(r.ok, true);
  assert.equal(hs.calls.length, 2, 'strict try, then the plain one');
  assert.deepEqual(Object.keys(hs.calls[1].body).sort(), ['budget', 'max_tokens', 'query', 'types']);
  const before = hs.calls.length;
  await recallWithFallback(send, recallBody('q2'));
  assert.equal(hs.calls.length - before, 1, 'the degraded state is remembered: no strict retry');
  hs.srv.close();
});

test('an ordinary failure (auth, server error, network) is not retried as a degradation', async () => {
  resetDegraded();
  const hs = await fakeServer(() => ({ status: 500, json: {} }));
  const r = await recallWithFallback((body) => post(hs.url, body), recallBody('q'));
  assert.equal(r.ok, false);
  assert.equal(hs.calls.length, 1);
  hs.srv.close();
});
