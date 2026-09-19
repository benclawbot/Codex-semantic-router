import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, buildCacheKey } from '../skills/bulk-semantic-filter/scripts/lib/cache.mjs';

test('cache key changes with inputs, goal, labels, and config', () => {
  const base = { backend: 'v1', labels: ['relevant', 'not relevant'], instructions: 'goal', inputs: ['alpha'], config: { threshold: 0.8 } };
  const first = buildCacheKey(base);
  assert.notEqual(first, buildCacheKey({ ...base, inputs: ['beta'] }));
  assert.notEqual(first, buildCacheKey({ ...base, instructions: 'other goal' }));
  assert.notEqual(first, buildCacheKey({ ...base, labels: ['yes', 'no'] }));
  assert.notEqual(first, buildCacheKey({ ...base, config: { threshold: 0.9 } }));
});

test('cache persists results but not raw candidate text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cache-'));
  const cache = new Cache({ dir, ttlSeconds: 3600 });
  const key = buildCacheKey({ labels: ['a', 'b'], instructions: 'private goal text', inputs: ['TOP SECRET SOURCE'], config: {} });
  await cache.set(key, { results: [{ label: 'a', confidence: 0.9 }] });
  const raw = await readFile(cache.pathFor(key), 'utf8');
  assert.doesNotMatch(raw, /TOP SECRET SOURCE/);
  assert.doesNotMatch(raw, /private goal text/);
  assert.deepEqual((await cache.get(key)).results, [{ label: 'a', confidence: 0.9 }]);
});

test('expired and corrupt cache entries are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cache-'));
  let now = Date.now();
  const cache = new Cache({ dir, ttlSeconds: 1, now: () => now });
  await cache.set('x', { results: [{ label: 'a' }] });
  now += 2000;
  assert.equal(await cache.get('x'), null);
});

test('disabled cache is a no-op', async () => {
  const cache = new Cache({ enabled: false });
  await cache.set('x', { results: [] });
  assert.equal(await cache.get('x'), null);
});
