import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../skills/bulk-semantic-filter/scripts/router.mjs';

function capture() { let text = ''; return { stream: { write(x) { text += String(x); } }, value: () => text }; }
function envFor(dir, extra = {}) { return { ...process.env, CODEX_SEMANTIC_ROUTER_CACHE_DIR: dir, CODEX_SEMANTIC_ROUTER_USER_CONFIG: join(dir, 'none.json'), ...extra }; }
function jsonResponse(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('tag preserves all records and emits route metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-')); const out = capture(); const err = capture();
  const input = Array.from({ length: 8 }, (_, i) => `diagnostic ${i}`).join('\n') + '\n';
  const code = await main(['tag', '--labels', 'compile error,other'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async (_u, init) => jsonResponse({ results: JSON.parse(init.body).inputs.map(() => ({ label: 'compile error', confidence: 0.9 })) })
  });
  assert.equal(code, 0);
  const rows = out.value().trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].route.label, 'compile error');
});

test('count returns aggregate categories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-')); const out = capture(); const err = capture();
  const input = Array.from({ length: 8 }, (_, i) => `item ${i}`).join('\n') + '\n';
  await main(['count', '--labels', 'bug,other'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async (_u, init) => jsonResponse({ results: JSON.parse(init.body).inputs.map((_, i) => ({ label: i % 2 ? 'bug' : 'other', confidence: 0.9 })) })
  });
  const body = JSON.parse(out.value());
  assert.equal(body.total, 8); assert.equal(body.counts.bug, 4); assert.equal(body.counts.other, 4);
});

test('uncertain emits only low-confidence plus unclassified records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-')); const out = capture(); const err = capture();
  const input = Array.from({ length: 8 }, (_, i) => `item ${i}`).join('\n') + '\n';
  await main(['uncertain', '--labels', 'bug,other', '--below', '0.7'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async (_u, init) => jsonResponse({ results: JSON.parse(init.body).inputs.map((_, i) => ({ label: 'bug', confidence: i < 3 ? 0.5 : 0.9 })) })
  });
  assert.equal(out.value().trim().split('\n').length, 3);
});

test('repository remote:false policy overrides defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-repo-')); await mkdir(join(dir, '.codex')); await writeFile(join(dir, '.codex', 'semantic-router.json'), '{"remote":false}');
  const out = capture(); const err = capture(); let called = false;
  const input = Array.from({ length: 8 }, (_, i) => `item ${i}`).join('\n') + '\n';
  await main(['filter', '--goal', 'x'], { stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir, fetchImpl: async () => { called = true; } });
  assert.equal(called, false); assert.equal(out.value(), input);
});

test('environment remote=0 has precedence over repository remote=true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-repo-')); await mkdir(join(dir, '.codex')); await writeFile(join(dir, '.codex', 'semantic-router.json'), '{"remote":true}');
  const out = capture(); const err = capture(); let called = false;
  const input = Array.from({ length: 8 }, (_, i) => `item ${i}`).join('\n') + '\n';
  await main(['filter', '--goal', 'x'], { stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir, { CODEX_SEMANTIC_ROUTER_REMOTE: '0' }), cwd: dir, fetchImpl: async () => { called = true; } });
  assert.equal(called, false); assert.equal(out.value(), input);
});

test('config command prints effective configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-')); const out = capture(); const err = capture();
  const code = await main(['config', '--threshold', '0.9'], { stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir });
  assert.equal(code, 0); assert.equal(JSON.parse(out.value()).relevance_threshold, 0.9);
});

test('health sends no repository content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-')); const out = capture(); const err = capture(); let initSeen;
  const code = await main(['health'], {
    stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async (_url, init) => { initSeen = init; return jsonResponse({ ok: true, version: 'v1' }); }
  });
  assert.equal(code, 0); assert.equal(initSeen.body, undefined); assert.equal(JSON.parse(out.value()).ok, true);
});
