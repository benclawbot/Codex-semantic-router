import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const DEFAULTS_PATH = join(ROOT_DIR, 'config', 'defaults.json');

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, ...overrides) {
  const out = structuredClone(base);
  for (const source of overrides) {
    if (!isObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (isObject(value) && isObject(out[key])) out[key] = deepMerge(out[key], value);
      else out[key] = structuredClone(value);
    }
  }
  return out;
}

async function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return {};
  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text);
  if (!isObject(parsed)) throw new Error(`config must contain a JSON object: ${path}`);
  return parsed;
}

export function findRepoConfig(start = process.cwd()) {
  let dir = resolve(start);
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, '.codex', 'semantic-router.json');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

function envBool(value) {
  if (value === undefined) return undefined;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function envNumber(value) {
  if (value === undefined || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function configFromEnv(env = process.env) {
  const cfg = {};
  const assign = (key, value) => {
    if (value !== undefined) cfg[key] = value;
  };
  assign('remote', envBool(env.CODEX_SEMANTIC_ROUTER_REMOTE));
  assign('mode', env.CODEX_SEMANTIC_ROUTER_MODE);
  assign('endpoint', env.CODEX_SEMANTIC_ROUTER_ENDPOINT);
  assign('min_items', envNumber(env.CODEX_SEMANTIC_ROUTER_MIN_ITEMS));
  assign('batch_size', envNumber(env.CODEX_SEMANTIC_ROUTER_BATCH_SIZE));
  assign('relevance_threshold', envNumber(env.CODEX_SEMANTIC_ROUTER_THRESHOLD));
  assign('uncertain_threshold', envNumber(env.CODEX_SEMANTIC_ROUTER_UNCERTAIN_THRESHOLD));
  assign('max_input_chars', envNumber(env.CODEX_SEMANTIC_ROUTER_MAX_INPUT_CHARS));
  assign('request_timeout_ms', envNumber(env.CODEX_SEMANTIC_ROUTER_TIMEOUT_MS));
  if (env.CODEX_SEMANTIC_ROUTER_CACHE !== undefined) cfg.cache = { enabled: envBool(env.CODEX_SEMANTIC_ROUTER_CACHE) };
  if (env.CODEX_SEMANTIC_ROUTER_CACHE_TTL_SECONDS !== undefined) {
    cfg.cache = { ...(cfg.cache ?? {}), ttl_seconds: envNumber(env.CODEX_SEMANTIC_ROUTER_CACHE_TTL_SECONDS) };
  }
  return cfg;
}

export function configFromCli(options = {}) {
  const cfg = {};
  const map = [
    ['threshold', 'relevance_threshold'],
    ['minItems', 'min_items'],
    ['batchSize', 'batch_size'],
    ['endpoint', 'endpoint'],
    ['mode', 'mode']
  ];
  for (const [src, dest] of map) if (options[src] !== undefined) cfg[dest] = options[src];
  if (options.noCache) cfg.cache = { enabled: false };
  if (options.offline) cfg.remote = false;
  return cfg;
}

export function validateConfig(config) {
  const error = (msg) => { throw new Error(`invalid configuration: ${msg}`); };
  if (!['classifier_dev'].includes(config.backend)) error('backend must be classifier_dev');
  if (!['active', 'shadow', 'disabled'].includes(config.mode)) error('mode must be active, shadow, or disabled');
  if (config.tier !== 'fast') error('only fast tier is supported by this router');
  if (typeof config.remote !== 'boolean') error('remote must be boolean');
  if (!/^https:\/\//.test(config.endpoint)) error('endpoint must be an https URL');
  if (!Number.isInteger(config.min_items) || config.min_items < 1) error('min_items must be a positive integer');
  if (!Number.isInteger(config.batch_size) || config.batch_size < 1 || config.batch_size > 1000) error('batch_size must be 1..1000');
  if (!(config.relevance_threshold >= 0 && config.relevance_threshold <= 1)) error('relevance_threshold must be 0..1');
  if (!(config.uncertain_threshold >= 0 && config.uncertain_threshold <= 1)) error('uncertain_threshold must be 0..1');
  if (!Number.isInteger(config.max_input_chars) || config.max_input_chars < 200 || config.max_input_chars > 32000) error('max_input_chars must be 200..32000');
  if (!Number.isInteger(config.request_timeout_ms) || config.request_timeout_ms < 100) error('request_timeout_ms must be >= 100');
  if (!Number.isInteger(config.max_retries) || config.max_retries < 0 || config.max_retries > 3) error('max_retries must be 0..3');
  if (!Number.isInteger(config.max_retry_after_ms) || config.max_retry_after_ms < 0) error('max_retry_after_ms must be >= 0');
  if (!Array.isArray(config.privacy?.sensitive_paths) || !config.privacy.sensitive_paths.every((x) => typeof x === 'string')) error('privacy.sensitive_paths must be an array of strings');
  if (!Array.isArray(config.privacy?.extra_secret_patterns) || !config.privacy.extra_secret_patterns.every((x) => typeof x === 'string')) error('privacy.extra_secret_patterns must be an array of strings');
  for (const pattern of config.privacy.extra_secret_patterns) { try { new RegExp(pattern, 'i'); } catch { error(`invalid extra secret regex: ${pattern}`); } }
  if (config.cache.store_raw_inputs !== false) error('cache.store_raw_inputs must remain false');
  if (!Number.isInteger(config.cache.ttl_seconds) || config.cache.ttl_seconds < 0) error('cache.ttl_seconds must be >= 0');
  if (!Number.isInteger(config.budget.classifications_per_minute) || config.budget.classifications_per_minute < 1) error('minute budget must be positive');
  if (!Number.isInteger(config.budget.classifications_per_day) || config.budget.classifications_per_day < 1) error('daily budget must be positive');
  return config;
}

export async function loadConfig({ cliOptions = {}, cwd = process.cwd(), env = process.env } = {}) {
  const defaults = await readJsonIfExists(DEFAULTS_PATH);
  const userPath = env.CODEX_SEMANTIC_ROUTER_USER_CONFIG || join(homedir(), '.config', 'codex-semantic-router', 'config.json');
  const repoPath = findRepoConfig(cwd);
  const explicitPath = cliOptions.config ? resolve(cwd, cliOptions.config) : null;
  const [userCfg, repoCfg, explicitCfg] = await Promise.all([
    readJsonIfExists(userPath),
    readJsonIfExists(repoPath),
    readJsonIfExists(explicitPath)
  ]);
  // --config is treated as an additional repository-like config; CLI flags still win.
  const config = deepMerge(defaults, userCfg, repoCfg, explicitCfg, configFromEnv(env), configFromCli(cliOptions));
  return validateConfig(config);
}

export function sanitizedConfig(config) {
  return structuredClone(config);
}

export { ROOT_DIR };
