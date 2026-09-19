import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassifierDevBackend, BackendError } from '../skills/bulk-semantic-filter/scripts/lib/api.mjs';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('uses stable v1 endpoint, explicit user agent, fast tier, and idempotency key', async () => {
  let seen;
  const backend = new ClassifierDevBackend({ fetchImpl: async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return jsonResponse({ results: [{ label: 'relevant', confidence: 0.9, scores: { relevant: 0.9, 'not relevant': 0.1 } }] });
  } });
  const result = await backend.classify({ inputs: ['x'], labels: ['relevant', 'not relevant'], instructions: 'goal' });
  assert.equal(seen.url, 'https://classifier.dev/v1/classify');
  assert.equal(seen.body.tier, 'fast');
  assert.equal(seen.init.headers['user-agent'], 'codex-semantic-router/0.1.0');
  assert.equal(seen.init.headers['idempotency-key'].length, 64);
  assert.equal(result.results[0].label, 'relevant');
});

test('batches and preserves response order', async () => {
  const calls = [];
  const backend = new ClassifierDevBackend({ batchSize: 2, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body.inputs);
    return jsonResponse({ results: body.inputs.map((x) => ({ label: x === 'b' ? 'not relevant' : 'relevant', confidence: 0.9 })) });
  } });
  const result = await backend.classify({ inputs: ['a', 'b', 'c'], labels: ['relevant', 'not relevant'], instructions: 'goal' });
  assert.deepEqual(calls, [['a', 'b'], ['c']]);
  assert.deepEqual(result.results.map((x) => x.label), ['relevant', 'not relevant', 'relevant']);
});

test('multi-label requests use multi=true and max_labels', async () => {
  let seen;
  const backend = new ClassifierDevBackend({ fetchImpl: async (_url, init) => {
    seen = JSON.parse(init.body);
    return jsonResponse({ results: [{ labels: ['code'], scores: { code: 0.9, docs: 0.1 } }] });
  } });
  await backend.classifyMulti({ inputs: ['x'], labels: ['code', 'docs'], instructions: 'tag', maxLabels: 2 });
  assert.equal(seen.multi, true);
  assert.equal(seen.max_labels, 2);
});

test('response count mismatch fails', async () => {
  const backend = new ClassifierDevBackend({ fetchImpl: async () => jsonResponse({ results: [] }) });
  await assert.rejects(() => backend.classify({ inputs: ['a'], labels: ['x', 'y'], instructions: '' }), /result count mismatch/);
});

test('invalid response label fails', async () => {
  const backend = new ClassifierDevBackend({ fetchImpl: async () => jsonResponse({ results: [{ label: 'z', confidence: 0.9 }] }) });
  await assert.rejects(() => backend.classify({ inputs: ['a'], labels: ['x', 'y'], instructions: '' }), /invalid label/);
});

test('502 retries once and then succeeds', async () => {
  let calls = 0;
  const backend = new ClassifierDevBackend({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return jsonResponse({ error: 'temporary', code: 'typesafe_502' }, 502);
    return jsonResponse({ results: [{ label: 'x', confidence: 0.9 }] });
  } });
  await backend.classify({ inputs: ['a'], labels: ['x', 'y'], instructions: '' });
  assert.equal(calls, 2);
});

test('429 exposes rate-limit metadata without task-specific text', async () => {
  const backend = new ClassifierDevBackend({ maxRetries: 0, fetchImpl: async () => jsonResponse({ error: 'limited', code: 'rate_limit_day' }, 429, { 'retry-after': '10' }) });
  await assert.rejects(
    () => backend.classify({ inputs: ['a'], labels: ['x', 'y'], instructions: '' }),
    (error) => error instanceof BackendError && error.rateLimited && error.dayLimit && error.retryAfterMs === 10000
  );
});

test('timeout is converted into BackendError', async () => {
  const backend = new ClassifierDevBackend({ timeoutMs: 20, maxRetries: 0, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }) });
  await assert.rejects(() => backend.classify({ inputs: ['a'], labels: ['x', 'y'], instructions: '' }), /timed out/);
});

test('unknown additive fields are ignored', async () => {
  const backend = new ClassifierDevBackend({ fetchImpl: async () => jsonResponse({ results: [{ label: 'x', confidence: 0.9, new_field: 'future' }], new_top_level: true }) });
  const result = await backend.classify({ inputs: ['a'], labels: ['x', 'y'], instructions: '' });
  assert.equal(result.results[0].new_field, 'future');
});
