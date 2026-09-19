import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldKeep, applySafetyFloor, OperationalState } from '../skills/bulk-semantic-filter/scripts/lib/policy.mjs';

const config = {
  budget: { classifications_per_minute: 3, classifications_per_day: 5 },
  circuit_breaker: { failure_window_ms: 300000, open_after: 3, cooldown_ms: 600000 }
};

test('retention is recall-first', () => {
  assert.equal(shouldKeep({ label: 'relevant', confidence: 0.99 }, 0.8), true);
  assert.equal(shouldKeep({ label: 'relevant', confidence: 0.2 }, 0.8), true);
  assert.equal(shouldKeep({ label: 'not relevant', confidence: 0.79 }, 0.8), true);
  assert.equal(shouldKeep({ label: 'not relevant', confidence: 0.8 }, 0.8), false);
  assert.equal(shouldKeep({ label: 'not relevant', confidence: null }, 0.8), true);
});

test('all-dropped safety floor selects highest relevant scores', () => {
  const records = [{}, {}, {}, {}];
  const results = [
    { scores: { relevant: 0.1 } },
    { scores: { relevant: 0.8 } },
    { scores: { relevant: 0.4 } },
    { scores: { relevant: 0.7 } }
  ];
  assert.deepEqual(applySafetyFloor(records, results, [], 3), [1, 2, 3]);
});

test('all-dropped safety floor keeps all when scores are unavailable', () => {
  assert.deepEqual(applySafetyFloor([{}, {}], [{}, {}], [], 3), [0, 1]);
});

test('minute and daily budgets are enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-state-'));
  let now = Date.parse('2026-09-19T10:00:00Z');
  const state = new OperationalState({ dir, config, now: () => now });
  await state.load();
  assert.equal(state.canClassify(3).ok, true);
  state.reserve(3);
  assert.equal(state.canClassify(1).reason, 'minute-budget');
  now += 61_000;
  assert.equal(state.canClassify(2).ok, true);
  state.reserve(2);
  now += 61_000;
  assert.equal(state.canClassify(1).reason, 'day-budget');
});

test('three failures open circuit and cooldown closes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-state-'));
  let now = Date.parse('2026-09-19T10:00:00Z');
  const state = new OperationalState({ dir, config, now: () => now });
  await state.load();
  state.noteFailure(); state.noteFailure();
  assert.equal(state.canClassify(1).ok, true);
  state.noteFailure();
  assert.equal(state.canClassify(1).reason, 'circuit-open');
  now += config.circuit_breaker.cooldown_ms + 1;
  assert.equal(state.canClassify(1).ok, true);
});

test('rate limit opens circuit immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csr-state-'));
  let now = Date.parse('2026-09-19T10:00:00Z');
  const state = new OperationalState({ dir, config, now: () => now });
  await state.load();
  state.noteFailure({ rateLimited: true, retryAfterMs: 1000 });
  assert.equal(state.canClassify(1).reason, 'circuit-open');
});
