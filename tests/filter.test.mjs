import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../skills/bulk-semantic-filter/scripts/router.mjs';

function capture() {
  let text = '';
  return { stream: { write(chunk) { text += String(chunk); } }, value: () => text };
}

function envFor(dir, extra = {}) {
  return {
    ...process.env,
    CODEX_SEMANTIC_ROUTER_CACHE_DIR: dir,
    CODEX_SEMANTIC_ROUTER_USER_CONFIG: join(dir, 'no-user-config.json'),
    ...extra
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('golden filter retains relevant and uncertain and drops only confident negatives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const input = Array.from({ length: 10 }, (_, i) => `candidate-${i}`).join('\n') + '\n';
  const out = capture(); const err = capture();
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ results: body.inputs.map((_, i) => {
      if (i < 2) return { label: 'relevant', confidence: 0.95, scores: { relevant: 0.95, 'not relevant': 0.05 } };
      if (i < 7) return { label: 'not relevant', confidence: 0.95, scores: { relevant: 0.05, 'not relevant': 0.95 } };
      return { label: 'not relevant', confidence: 0.6, scores: { relevant: 0.4, 'not relevant': 0.6 } };
    }) });
  };
  const code = await main(['filter', '--goal', 'find useful implementation'], { stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), fetchImpl, cwd: dir });
  assert.equal(code, 0);
  assert.deepEqual(out.value().trim().split('\n'), ['candidate-0', 'candidate-1', 'candidate-7', 'candidate-8', 'candidate-9']);
  assert.match(err.value(), /10 candidates, 5 retained, 5 dropped, 3 uncertain/);
});

test('fewer than min_items pass through without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const out = capture(); const err = capture();
  let called = false;
  const code = await main(['filter', '--goal', 'x'], {
    stdin: 'a\nb\nc\n', stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async () => { called = true; throw new Error('should not call'); }
  });
  assert.equal(code, 0);
  assert.equal(called, false);
  assert.equal(out.value(), 'a\nb\nc\n');
});

test('hard lower bound of five applies even if min_items is configured lower', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const out = capture(); const err = capture();
  let called = false;
  const code = await main(['filter', '--goal', 'x', '--min-items', '1'], {
    stdin: 'a\nb\nc\nd\n', stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async () => { called = true; return jsonResponse({ results: [] }); }
  });
  assert.equal(code, 0);
  assert.equal(called, false);
});

test('--force can classify a small set but cannot bypass secret protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const out = capture(); const err = capture();
  let requestBody;
  const code = await main(['filter', '--goal', 'x', '--force'], {
    stdin: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz\nordinary candidate\n',
    stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return jsonResponse({ results: [{ label: 'not relevant', confidence: 0.99, scores: { relevant: 0.01, 'not relevant': 0.99 } }] });
    }
  });
  assert.equal(code, 0);
  assert.equal(requestBody.inputs.length, 1);
  assert.doesNotMatch(requestBody.inputs[0], /Bearer/);
  assert.match(out.value(), /Authorization: Bearer/);
});

test('backend failure passes all candidates through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const input = Array.from({ length: 8 }, (_, i) => `item-${i}`).join('\n') + '\n';
  const out = capture(); const err = capture();
  const code = await main(['filter', '--goal', 'x'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async () => jsonResponse({ error: 'upstream failed', code: 'typesafe_502' }, 502)
  });
  assert.equal(code, 0);
  assert.equal(out.value(), input);
  assert.match(err.value(), /fail-open pass-through/);
});

test('all-negative high-confidence classification applies safety floor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const input = Array.from({ length: 8 }, (_, i) => `item-${i}`).join('\n') + '\n';
  const out = capture(); const err = capture();
  const scores = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];
  await main(['filter', '--goal', 'x'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async () => jsonResponse({ results: scores.map((score) => ({ label: 'not relevant', confidence: 0.99, scores: { relevant: score, 'not relevant': 1 - score } })) })
  });
  assert.deepEqual(out.value().trim().split('\n'), ['item-1', 'item-3', 'item-5']);
});

test('JSONL sends only selected text field and preserves the original object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `id-${i}`, text: `candidate ${i}`, private_local_field: `local-${i}` }));
  const out = capture(); const err = capture(); let body;
  await main(['filter', '--format', 'jsonl', '--goal', 'x'], {
    stdin: rows.map(JSON.stringify).join('\n') + '\n', stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return jsonResponse({ results: rows.map(() => ({ label: 'relevant', confidence: 0.9 })) }); }
  });
  assert.equal(body.inputs.some((x) => x.includes('private_local_field')), false);
  const first = JSON.parse(out.value().trim().split('\n')[0]);
  assert.equal(first.private_local_field, 'local-0');
  assert.equal(first.route.label, 'relevant');
});

test('offline mode never calls network and passes through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const input = Array.from({ length: 8 }, (_, i) => `item-${i}`).join('\n') + '\n';
  const out = capture(); const err = capture(); let called = false;
  const code = await main(['filter', '--goal', 'x', '--offline'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async () => { called = true; throw new Error('network'); }
  });
  assert.equal(code, 0); assert.equal(called, false); assert.equal(out.value(), input);
});

test('shadow mode emits all candidates despite confident negatives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-cli-'));
  const input = Array.from({ length: 8 }, (_, i) => `item-${i}`).join('\n') + '\n';
  const out = capture(); const err = capture();
  await main(['filter', '--goal', 'x', '--mode', 'shadow'], {
    stdin: input, stdout: out.stream, stderr: err.stream, env: envFor(dir), cwd: dir,
    fetchImpl: async () => jsonResponse({ results: Array.from({ length: 8 }, () => ({ label: 'not relevant', confidence: 0.99, scores: { relevant: 0.01, 'not relevant': 0.99 } })) })
  });
  assert.equal(out.value(), input);
  assert.match(err.value(), /shadow mode/);
});
