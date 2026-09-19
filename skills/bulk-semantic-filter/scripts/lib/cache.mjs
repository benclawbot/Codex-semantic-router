import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function dataDir(env = process.env) {
  if (env.CODEX_SEMANTIC_ROUTER_CACHE_DIR) return env.CODEX_SEMANTIC_ROUTER_CACHE_DIR;
  if (env.PLUGIN_DATA) return join(env.PLUGIN_DATA, 'codex-semantic-router');
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'codex-semantic-router');
  return join(homedir(), '.cache', 'codex-semantic-router');
}

export function buildCacheKey({ backend = 'classifier_dev:v1', labels, instructions, inputs, config = {} }) {
  const payload = {
    backend,
    labels: [...labels].map(String),
    instructions: String(instructions ?? ''),
    input_hashes: inputs.map((item) => sha256(item)),
    config
  };
  return sha256(JSON.stringify(payload));
}

export class Cache {
  constructor({ dir = dataDir(), enabled = true, ttlSeconds = 3600, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.enabled = enabled;
    this.ttlMs = ttlSeconds * 1000;
    this.now = now;
  }
  pathFor(key) { return join(this.dir, 'cache', `${key}.json`); }
  async get(key) {
    if (!this.enabled) return null;
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      const created = Date.parse(parsed.created_at);
      if (!Number.isFinite(created) || this.now() - created > this.ttlMs) return null;
      if (!Array.isArray(parsed.results)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  async set(key, value) {
    if (!this.enabled) return;
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const payload = { created_at: new Date(this.now()).toISOString(), api_version: 'v1', results: value.results };
    if (value.inspect) payload.inspect = value.inspect;
    if (value.clipped) payload.clipped = value.clipped;
    const body = JSON.stringify(payload);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try { await rename(tmp, path); } catch (error) { if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error; await rm(path, { force: true }); await rename(tmp, path); }
  }
  async gc() {
    if (!this.enabled) return { scanned: 0, removed: 0 };
    const cacheDir = join(this.dir, 'cache');
    if (!existsSync(cacheDir)) return { scanned: 0, removed: 0 };
    const names = await readdir(cacheDir);
    let scanned = 0, removed = 0;
    for (const name of names) {
      const path = join(cacheDir, name);
      if (!name.endsWith('.json')) continue;
      scanned++;
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        const created = Date.parse(parsed.created_at);
        if (Number.isFinite(created) && this.now() - created > this.ttlMs) {
          await rm(path, { force: true });
          removed++;
        }
      } catch {
        await rm(path, { force: true });
        removed++;
      }
    }
    return { scanned, removed };
  }
  async clear() {
    const cacheDir = join(this.dir, 'cache');
    if (!existsSync(cacheDir)) return { removed: 0 };
    const names = (await readdir(cacheDir)).filter((n) => n.endsWith('.json'));
    for (const name of names) await rm(join(cacheDir, name), { force: true });
    return { removed: names.length };
  }
  async stats() {
    const cacheDir = join(this.dir, 'cache');
    if (!existsSync(cacheDir)) return { files: 0, bytes: 0, oldest_ms: null, newest_ms: null };
    const names = await readdir(cacheDir);
    let bytes = 0, oldest = Infinity, newest = 0;
    for (const n of names) {
      try {
        const s = await stat(join(cacheDir, n));
        bytes += s.size;
        if (s.mtimeMs < oldest) oldest = s.mtimeMs;
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      } catch {}
    }
    return {
      files: names.length,
      bytes,
      oldest_ms: oldest === Infinity ? null : Math.round(oldest),
      newest_ms: newest === 0 ? null : Math.round(newest)
    };
  }
}
