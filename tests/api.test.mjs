import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassifierDevBackend, BackendError } from '../skills/bulk-semantic-filter/scripts/lib/api.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'bsf-api-'));
}

const CONFIG_BASE = {
  backend: 'classifier_dev',
  remote: true,
  tier: 'fast',
  endpoint: 'https://classifier.dev/v1/classify',
  min_items: 8,
  batch_size: 500,
  max_concurrency: 4,
  relevance_threshold: 0.8,
  uncertain_threshold: 0.7,
  max_input_chars: 8000,
  request_timeout_ms: 5000,
  max_retries: 1,
  max_retry_after_ms: 3000,
  circuit_breaker: { failure_window_ms: 300000, open_after: 3, cooldown_ms: 600000 },
  cache: { enabled: true, ttl_seconds: 3600, store_raw_inputs: false },
  budget: { classifications_per_minute: 2000, classifications_per_day: 12000 },
  privacy: { payload_policy: 'metadata_and_snippets', block_probable_secrets: true, sensitive_paths: [], extra_secret_patterns: [] },
  mode: 'active'
};

function stubFetch(respond) {
  return async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    const res = await respond(url, body);
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      headers: { get: (k) => k.toLowerCase() === 'retry-after' ? (res.retryAfter || null) : null },
      json: async () => res.body
    };
  };
}

test('backend respects batchSize to split a 1200-item run into chunks', async () => {
  const dir = tmpDir();
  try {
    let callCount = 0;
    let lastBatchSize = 0;
    const fetch = stubFetch((url, body) => {
      callCount++;
      lastBatchSize = body.inputs.length;
      return { body: { results: body.inputs.map(() => ({ label: 'relevant', confidence: 0.9 })) } };
    });
    const backend = new ClassifierDevBackend({ batchSize: 500, maxConcurrency: 1, fetchImpl: fetch });
    const inputs = Array.from({ length: 1200 }, (_, i) => `item-${i}`);
    const result = await backend.classify({ inputs, labels: ['relevant', 'not relevant'], instructions: 'x' });
    assert.equal(callCount, 3);
    assert.equal(lastBatchSize, 200);
    assert.equal(result.results.length, 1200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backend fetches batches in parallel up to maxConcurrency', async () => {
  const dir = tmpDir();
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const respond = async (url, body) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      completed++;
      return { body: { results: body.inputs.map(() => ({ label: 'relevant', confidence: 0.9 })) } };
    };
    const fetch = stubFetch(respond);
    const backend = new ClassifierDevBackend({ batchSize: 500, maxConcurrency: 4, fetchImpl: fetch });
    const inputs = Array.from({ length: 2000 }, (_, i) => `item-${i}`);
    await backend.classify({ inputs, labels: ['relevant', 'not relevant'], instructions: 'x' });
    assert.equal(completed, 4);
    assert.ok(maxInFlight >= 2 && maxInFlight <= 4, `expected concurrent fetches, got max ${maxInFlight}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backend throws when backend returns wrong result count', async () => {
  const dir = tmpDir();
  try {
    const fetch = stubFetch(() => ({ body: { results: [{ label: 'relevant' }] } }));
    const backend = new ClassifierDevBackend({ batchSize: 500, maxConcurrency: 1, fetchImpl: fetch });
    await assert.rejects(
      backend.classify({ inputs: ['a', 'b'], labels: ['relevant', 'not relevant'], instructions: 'x' }),
      (err) => err instanceof BackendError && /result count mismatch/.test(err.message)
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backend retries on 503 and eventually succeeds', async () => {
  const dir = tmpDir();
  try {
    let attempts = 0;
    const fetch = stubFetch(() => {
      attempts++;
      if (attempts === 1) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: 'busy' }) };
      return { body: { results: [{ label: 'relevant', confidence: 0.9 }] } };
    });
    const backend = new ClassifierDevBackend({ batchSize: 500, maxRetries: 1, fetchImpl: fetch });
    const result = await backend.classify({ inputs: ['a'], labels: ['relevant', 'not relevant'], instructions: 'x' });
    assert.equal(attempts, 2);
    assert.equal(result.results.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
