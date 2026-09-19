import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './cache.mjs';

export function shouldKeep(result, threshold = 0.8) {
  if (!result || result.label === 'relevant') return true;
  if (result.confidence == null) return true;
  return Number(result.confidence) < threshold;
}

export function applySafetyFloor(records, results, keptIndexes, topK = 3) {
  if (keptIndexes.length > 0 || records.length === 0) return keptIndexes;
  const cap = Math.min(topK, records.length);
  const ranked = records.map((record, i) => ({
    i,
    score: Number(results[i]?.scores?.relevant)
  }));
  if (ranked.some((x) => Number.isFinite(x.score))) {
    return ranked
      .sort((a, b) => (Number.isFinite(b.score) ? b.score : -1) - (Number.isFinite(a.score) ? a.score : -1))
      .slice(0, cap)
      .map((x) => x.i)
      .sort((a, b) => a - b);
  }
  return records.slice(0, cap).map((_, i) => i);
}

function freshState() {
  return {
    minute_start: 0,
    minute_count: 0,
    day: '',
    day_count: 0,
    consecutive_failures: 0,
    last_failure_at: 0,
    open_until: 0
  };
}

export class OperationalState {
  constructor({ dir = dataDir(), config, now = () => Date.now() } = {}) {
    this.path = join(dir, 'state.json');
    this.config = config;
    this.now = now;
    this.state = freshState();
  }
  async load() {
    if (!existsSync(this.path)) return this.state;
    try {
      this.state = { ...freshState(), ...JSON.parse(await readFile(this.path, 'utf8')) };
    } catch {
      this.state = freshState();
    }
    return this.state;
  }
  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    try { await rename(tmp, this.path); } catch (error) { if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error; await rm(this.path, { force: true }); await rename(tmp, this.path); }
  }
  normalize() {
    const now = this.now();
    if (this.state.minute_start === 0 || (this.state.minute_start > 0 && now - this.state.minute_start >= 60_000)) {
      this.state.minute_start = now;
      this.state.minute_count = 0;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.day_count = 0;
    }
    const windowMs = this.config.circuit_breaker.failure_window_ms;
    if (this.state.last_failure_at === 0 || (this.state.last_failure_at > 0 && now - this.state.last_failure_at > windowMs)) {
      this.state.consecutive_failures = 0;
      this.state.last_failure_at = 0;
    }
  }
  canClassify(count) {
    this.normalize();
    const now = this.now();
    if (this.state.open_until > now) return { ok: false, reason: 'circuit-open', retryAfterMs: this.state.open_until - now };
    if (this.state.minute_count + count > this.config.budget.classifications_per_minute) return { ok: false, reason: 'minute-budget' };
    if (this.state.day_count + count > this.config.budget.classifications_per_day) return { ok: false, reason: 'day-budget' };
    return { ok: true };
  }
  reserve(count) {
    this.normalize();
    if (this.state.minute_start === 0) this.state.minute_start = this.now();
    this.state.minute_count += count;
    this.state.day_count += count;
  }
  release(count) {
    this.normalize();
    this.state.minute_count = Math.max(0, this.state.minute_count - count);
    this.state.day_count = Math.max(0, this.state.day_count - count);
  }
  noteSuccess() {
    this.state.consecutive_failures = 0;
    this.state.last_failure_at = 0;
    if (this.state.open_until <= this.now()) this.state.open_until = 0;
  }
  noteFailure({ rateLimited = false, retryAfterMs = 0, dayLimit = false } = {}) {
    const now = this.now();
    this.normalize();
    this.state.consecutive_failures += 1;
    this.state.last_failure_at = now;
    if (rateLimited) {
      let openFor;
      if (dayLimit) openFor = retryAfterMs > 0 ? retryAfterMs : 60 * 60_000;
      else if (retryAfterMs > 0) openFor = retryAfterMs;
      else openFor = this.config.circuit_breaker.cooldown_ms;
      this.state.open_until = Math.max(this.state.open_until, now + openFor);
      return;
    }
    if (this.state.consecutive_failures >= this.config.circuit_breaker.open_after) {
      this.state.open_until = now + this.config.circuit_breaker.cooldown_ms;
    }
  }
}
