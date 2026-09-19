import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassifierDevBackend } from '../skills/bulk-semantic-filter/scripts/lib/api.mjs';

const enabled = process.env.ALLOW_CLASSIFIER_NETWORK_TESTS === '1';

test('classifier.dev public health and batch smoke test', { skip: !enabled }, async () => {
  const backend = new ClassifierDevBackend({ timeoutMs: 10000 });
  const health = await backend.health();
  assert.equal(health.ok, true);
  const result = await backend.classify({
    inputs: ['The compiler reports a type mismatch.', 'A recipe for chocolate cake.'],
    labels: ['software engineering', 'cooking'],
    instructions: 'Classify by primary topic.'
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].label, 'software engineering');
  assert.equal(result.results[1].label, 'cooking');
});
