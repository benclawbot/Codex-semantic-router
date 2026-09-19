import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../skills/bulk-semantic-filter/scripts/router.mjs';

function makeCtx(extra = {}) {
  const writes = { stdout: [], stderr: [] };
  const dir = mkdtempSync(join(tmpdir(), 'bsf-cache-test-'));
  return {
    stdin: '',
    stdout: { write: (s) => writes.stdout.push(s) },
    stderr: { write: (s) => writes.stderr.push(s) },
    env: { ...process.env, CODEX_SEMANTIC_ROUTER_CACHE_DIR: dir, CODEX_SEMANTIC_ROUTER_REMOTE: extra.remote ?? '1' },
    cwd: process.cwd(),
    fetchImpl: extra.fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    _writes: writes,
    _dir: dir
  };
}

test('second filter run on identical input hits cache without backend call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsf-cache-shared-'));
  try {
    const items = Array.from({ length: 10 }, (_, i) => `item ${i}`);
    const stdin = items.join('\n') + '\n';
    const makeSharedCtx = (extra) => {
      const writes = { stdout: [], stderr: [] };
      return {
        stdin,
        stdout: { write: (s) => writes.stdout.push(s) },
        stderr: { write: (s) => writes.stderr.push(s) },
        env: { ...process.env, CODEX_SEMANTIC_ROUTER_CACHE_DIR: dir, CODEX_SEMANTIC_ROUTER_REMOTE: '1' },
        cwd: process.cwd(),
        fetchImpl: extra.fetchImpl,
        _writes: writes
      };
    };

    let fetchCalls = 0;
    const ctx1 = makeSharedCtx({
      fetchImpl: async () => {
        fetchCalls++;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: items.map(() => ({ label: 'relevant', confidence: 0.9 })) }) };
      }
    });
    const code1 = await main(['filter', '--goal', 'find x', '--output', 'jsonl'], ctx1);
    assert.equal(code1, 0);
    assert.equal(fetchCalls, 1, 'first run should call backend');

    const ctx2 = makeSharedCtx({
      fetchImpl: async () => { throw new Error('should not be called'); }
    });
    const code2 = await main(['filter', '--goal', 'find x', '--output', 'jsonl'], ctx2);
    assert.equal(code2, 0);
    assert.match(ctx2._writes.stderr.join(''), /cache hit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache hit returns identical results to first run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsf-cache-shared-'));
  try {
    const items = Array.from({ length: 10 }, (_, i) => `text ${i}`);
    const stdin = items.join('\n') + '\n';

    const makeSharedCtx = (extra) => {
      const writes = { stdout: [], stderr: [] };
      return {
        stdin,
        stdout: { write: (s) => writes.stdout.push(s) },
        stderr: { write: (s) => writes.stderr.push(s) },
        env: { ...process.env, CODEX_SEMANTIC_ROUTER_CACHE_DIR: dir, CODEX_SEMANTIC_ROUTER_REMOTE: '1' },
        cwd: process.cwd(),
        fetchImpl: extra.fetchImpl,
        _writes: writes
      };
    };

    const ctx1 = makeSharedCtx({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: body.inputs.map(() => ({ label: 'relevant', confidence: 0.9 })) }) };
      }
    });
    const code1 = await main(['filter', '--goal', 'find x', '--output', 'jsonl'], ctx1);
    assert.equal(code1, 0);
    const firstOutput = ctx1._writes.stdout.join('');

    const ctx2 = makeSharedCtx({
      fetchImpl: async () => { throw new Error('should not be called on cache hit'); }
    });
    const code2 = await main(['filter', '--goal', 'find x', '--output', 'jsonl'], ctx2);
    assert.equal(code2, 0);
    assert.equal(ctx2._writes.stdout.join(''), firstOutput);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
