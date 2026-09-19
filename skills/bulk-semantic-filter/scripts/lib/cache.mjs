import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
    const body = JSON.stringify({ created_at: new Date(this.now()).toISOString(), api_version: 'v1', results: value.results });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try { await rename(tmp, path); } catch (error) { if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error; await rm(path, { force: true }); await rename(tmp, path); }
  }
}
