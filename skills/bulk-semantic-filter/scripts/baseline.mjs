#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = join(SKILL_DIR, 'scripts', 'router.mjs');
const BASELINE_DIR = join(process.env.HOME || '/tmp', '.cache', 'codex-semantic-router', 'baselines');

const SECRET_SAMPLES = [
  { name: 'pem-private-key', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ...REDACTED_EXAMPLE_KEY_DO_NOT_USE' },
  { name: 'bearer-header', text: 'Authorization: Bearer ya29.EXAMPLE_TOKEN_PLACEHOLDER_DO_NOT_USE' },
  { name: 'aws-access-key', text: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE' },
  { name: 'github-token', text: 'token = ghp_16C7e42F292c6912E7710c838347Ae178B4a' },
  { name: 'dotenv-secret', text: 'STRIPE_SECRET_KEY=sk_test_PLACEHOLDER_REPLACE_ME' },
  { name: 'jwt', text: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSmeJJcZIbAxI' },
  { name: 'benign-readme', text: 'This project provides a thin wrapper around the classifier.dev HTTP API.' },
];

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function readState(dir) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return { _error: 'unparseable' }; }
}

async function cacheStats(dir) {
  const cacheDir = join(dir, 'cache');
  if (!existsSync(cacheDir)) return { files: 0, bytes: 0, oldest_ms: null, newest_ms: null };
  const names = await readdir(cacheDir);
  let bytes = 0, oldest = Infinity, newest = 0;
  for (const n of names) {
    const s = await stat(join(cacheDir, n));
    bytes += s.size;
    if (s.mtimeMs < oldest) oldest = s.mtimeMs;
    if (s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return {
    files: names.length,
    bytes,
    oldest_ms: oldest === Infinity ? null : Math.round(oldest),
    newest_ms: newest === 0 ? null : Math.round(newest),
  };
}

async function runHealth() {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = spawnSync('node', [ROUTER, 'health'], { encoding: 'utf8' });
    const dt = performance.now() - t0;
    if (r.status !== 0) return { error: r.stderr.trim(), latency_ms: Math.round(dt) };
    try {
      const j = JSON.parse(r.stdout);
      samples.push({ latency_ms: Math.round(dt), response: j });
    } catch {
      samples.push({ latency_ms: Math.round(dt), response: { _unparseable: r.stdout } });
    }
  }
  return { latency_ms_median: median(samples.map((s) => s.latency_ms)), samples };
}

async function runSyntheticFilter() {
  const lines = [];
  const topics = [
    'delete_session removes persisted state in src/session/store.rs',
    'token refresh logic in src/auth/login.rs',
    'add sessions table migration in src/db/migrate.rs',
    'Update README screenshots',
    'Fix flaky network retry test',
    'Refactor cache eviction policy',
    'Add trace logging to classifier wrapper',
    'Document the .opencode/semantic-router.json override',
    'Bump dependency versions',
    'Fix typo in error message',
    'Add benchmark for 1000-item batch',
    'Improve safety floor scoring',
    'Move circuit breaker state file to XDG cache home',
    'Strip leading whitespace from JSONL inputs',
    'Allow custom secret regex patterns',
    'Add --format ndjson alias for jsonl',
    'Reduce per-request latency by 5ms',
    'Expose router stats via --stats flag',
    'Migrate from callback API to async iterators',
    'Add integration test against mock backend',
  ];
  for (let i = 0; i < topics.length; i++) lines.push(`item-${i}\t${topics[i]}`);
  const input = lines.join('\n') + '\n';
  const t0 = performance.now();
  const r = spawnSync('node', [
    ROUTER, 'filter',
    '--goal', 'Find implementation code for deleting persisted sessions',
    '--force',
  ], { input, encoding: 'utf8', timeout: 30_000 });
  const dt = performance.now() - t0;
  if (r.status !== 0) return { error: (r.stderr || r.stdout || '').trim(), latency_ms: Math.round(dt) };
  const kept = r.stdout.trim().split('\n').filter(Boolean).length;
  const expectedMin = 1;
  const expectedMax = 6;
  return {
    latency_ms: Math.round(dt),
    candidates: topics.length,
    retained: kept,
    dropped: topics.length - kept,
    expected_min: expectedMin,
    expected_max: expectedMax,
    relevance_drift: kept < expectedMin || kept > expectedMax
  };
}

async function privacyCheck() {
  const { detectSecret, inspectRecord } = await import(join(SKILL_DIR, 'scripts', 'lib', 'redact.mjs'));
  const privacy = {
    sensitive_paths: ['.env', '.env.*', '**/.ssh/**', '**/*id_rsa*', '**/*.pem'],
    block_probable_secrets: true,
    extra_secret_patterns: []
  };
  const secretSamples = [
    ...SECRET_SAMPLES.filter((s) => s.name !== 'benign-readme').map((s) => ({ ...s, expected_sensitive: true })),
    { name: 'benign-readme', text: 'This project provides a thin wrapper around the classifier.dev HTTP API.', expected_sensitive: false }
  ];
  const secretResults = secretSamples.map((s) => {
    const r = detectSecret(s.text);
    return { name: s.name, expected: s.expected_sensitive, sensitive: r.sensitive, reason: r.reason, correct: r.sensitive === s.expected_sensitive };
  });
  const pathCases = [
    { name: 'env', path: '.env.production', text: 'plain text', expected: true },
    { name: 'pem', path: 'certs/server.pem', text: 'no secrets here', expected: true },
    { name: 'ssh-id_rsa', path: 'home/user/.ssh/id_rsa', text: 'public key info', expected: true },
    { name: 'ssh-dir', path: '.ssh/config', text: 'host stuff', expected: true },
    { name: 'clean', path: 'src/main.rs', text: 'let x = 1;', expected: false }
  ];
  const pathResults = pathCases.map((c) => {
    const r = inspectRecord({ path: c.path, text: c.text }, privacy);
    return { name: c.name, path: c.path, expected: c.expected, sensitive: r.sensitive, reason: r.reason, correct: r.sensitive === c.expected };
  });
  return { secret_results: secretResults, path_results: pathResults };
}

async function skillInstallCheck() {
  const skillMd = join(SKILL_DIR, 'SKILL.md');
  const ok = existsSync(skillMd);
  if (!ok) return { installed: false };
  const text = await readFile(skillMd, 'utf8');
  const fm = text.startsWith('---') ? text.split('---', 3)[1] : '';
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  const desc = (fm.match(/description:\s*(.+)$/m) || [])[1]?.trim();
  return {
    installed: true,
    path: SKILL_DIR,
    name,
    description_chars: desc ? desc.length : 0,
    router_present: existsSync(ROUTER),
  };
}

async function testSuiteCheck() {
  const testsDir = join(SKILL_DIR, 'tests');
  if (existsSync(testsDir)) {
    const r = spawnSync('node', ['--test', '--test-reporter=tap', 'tests/'], { cwd: SKILL_DIR, encoding: 'utf8', timeout: 60_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const passed = (out.match(/^ok \d+/gm) || []).length;
    const failed = (out.match(/^not ok \d+/gm) || []).length;
    return { source: 'local', passed, failed, status: r.status, exit_signal: r.signal || null };
  }
  const upstream = resolve(process.env.HOME, 'Codex-semantic-router', 'tests');
  if (existsSync(upstream)) {
    const r = spawnSync('npm', ['test', '--silent'], { cwd: resolve(process.env.HOME, 'Codex-semantic-router'), encoding: 'utf8', timeout: 60_000 });
    const out = r.stdout || '';
    return { source: 'upstream', passed: (out.match(/✔/g) || []).length, failed: (out.match(/✖/g) || []).length };
  }
  return { source: 'none', passed: 0, failed: 0 };
}

async function takeSnapshot() {
  const dataDir = (await import(join(SKILL_DIR, 'scripts', 'lib', 'cache.mjs'))).dataDir();
  const synthetic_filter = await runSyntheticFilter();
  const privacy = await privacyCheck();
  const secret_correct = (privacy.secret_results || []).filter((s) => s.correct).length;
  const secret_total = (privacy.secret_results || []).length;
  const path_correct = (privacy.path_results || []).filter((s) => s.correct).length;
  const path_total = (privacy.path_results || []).length;
  return {
    schema: 2,
    timestamp: new Date().toISOString(),
    node: process.version,
    skill: await skillInstallCheck(),
    runtime_state: await readState(dataDir),
    cache: await cacheStats(dataDir),
    health: await runHealth(),
    synthetic_filter,
    privacy_detector: privacy,
    privacy_summary: { secret_correct, secret_total, path_correct, path_total },
    tests: await testSuiteCheck(),
  };
}

function migrateSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  if (snap.schema === 2) return snap;
  if (snap.schema === 1) {
    const migrated = { ...snap, schema: 2 };
    if (Array.isArray(migrated.privacy_detector)) {
      const secret_results = migrated.privacy_detector.map((s) => ({
        name: s.name,
        expected: s.detected?.sensitive === true,
        sensitive: s.detected?.sensitive === true,
        reason: s.detected?.reason || null,
        correct: true
      }));
      migrated.privacy_detector = { secret_results, path_results: [] };
      migrated.privacy_summary = {
        secret_correct: secret_results.length,
        secret_total: secret_results.length,
        path_correct: 0,
        path_total: 0
      };
    }
    if (migrated.synthetic_filter && typeof migrated.synthetic_filter.expected_min === 'undefined') {
      migrated.synthetic_filter = {
        ...migrated.synthetic_filter,
        expected_min: 1,
        expected_max: 6,
        relevance_drift: migrated.synthetic_filter.retained < 1 || migrated.synthetic_filter.retained > 6
      };
    }
    return migrated;
  }
  return snap;
}

function fmt(v) {
  if (v == null) return '∅';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return JSON.stringify(v);
}

function diffSnapshots(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of [...keys].sort()) {
    const va = a?.[k]; const vb = b?.[k];
    if (va && typeof va === 'object' && !Array.isArray(va) && vb && typeof vb === 'object') {
      const sub = diffSnapshots(va, vb, `${prefix}${k}.`);
      if (sub) out.push(sub);
      continue;
    }
    if (Array.isArray(va) && Array.isArray(vb)) {
      const sa = JSON.stringify(va), sb = JSON.stringify(vb);
      if (sa !== sb) out.push(`${prefix}${k}: [array changed, ${va.length}→${vb.length} items]`);
      continue;
    }
    if (va !== vb) out.push(`${prefix}${k}: ${fmt(va)} → ${fmt(vb)}`);
  }
  return out.length ? out.join('\n') : null;
}

async function listBaselines() {
  if (!existsSync(BASELINE_DIR)) return [];
  const names = await readdir(BASELINE_DIR);
  const rows = await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => {
    const s = await stat(join(BASELINE_DIR, n));
    return { file: n, mtime: s.mtime.toISOString(), bytes: s.size };
  }));
  return rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv[0] === 'help') {
    process.stdout.write(`usage: baseline.mjs [snapshot | diff <file> | list]

  snapshot   capture current state to ~/.cache/codex-semantic-router/baselines/<iso>.json (default)
  diff FILE  take a fresh snapshot and print changes vs FILE
  list       show saved baselines\n`);
    return 0;
  }

  await mkdir(BASELINE_DIR, { recursive: true });

  const cmd = argv[0] || 'snapshot';

  if (cmd === 'list') {
    const rows = await listBaselines();
    for (const r of rows) process.stdout.write(`${r.mtime}  ${r.bytes}B  ${r.file}\n`);
    return 0;
  }

  if (cmd === 'diff') {
    const target = argv[1];
    if (!target) { process.stderr.write('diff: missing baseline file\n'); return 2; }
    const targetPath = existsSync(target) ? target : join(BASELINE_DIR, target);
    if (!existsSync(targetPath)) { process.stderr.write(`diff: not found: ${targetPath}\n`); return 2; }
    const prev = migrateSnapshot(JSON.parse(await readFile(targetPath, 'utf8')));
    const fresh = await takeSnapshot();
    const diff = diffSnapshots(prev, fresh);
    process.stdout.write(diff ?? 'no changes\n');
    if (fresh.synthetic_filter?.relevance_drift) process.stderr.write('warning: synthetic filter retention outside expected range (relevance_drift)\n');
    if (fresh.runtime_state?.open_until && fresh.runtime_state.open_until > Date.now()) process.stderr.write('warning: circuit breaker is currently open\n');
    return 0;
  }

  if (cmd === 'snapshot') {
    const snap = await takeSnapshot();
    const stamp = snap.timestamp.replace(/[:.]/g, '-');
    const file = join(BASELINE_DIR, `${stamp}.json`);
    await writeFile(file, JSON.stringify(snap, null, 2));
    const circuitOpen = snap.runtime_state?.open_until && snap.runtime_state.open_until > Date.now();
    process.stdout.write(`wrote ${file}\n`);
    process.stdout.write(`  health latency: ${snap.health.latency_ms_median ?? '?'}ms\n`);
    const drift = snap.synthetic_filter.relevance_drift ? ' DRIFT' : '';
    process.stdout.write(`  filter latency: ${snap.synthetic_filter.latency_ms ?? '?'}ms (${snap.synthetic_filter.retained ?? '?'}/${snap.synthetic_filter.candidates ?? '?'} kept, expected ${snap.synthetic_filter.expected_min}-${snap.synthetic_filter.expected_max})${drift}\n`);
    process.stdout.write(`  cache entries: ${snap.cache.files} (${snap.cache.bytes}B)\n`);
    process.stdout.write(`  budget: minute ${snap.runtime_state?.minute_count ?? 0}/${snap.runtime_state ? 2000 : '?'}, day ${snap.runtime_state?.day_count ?? 0}/${snap.runtime_state ? 12000 : '?'}, circuit: ${circuitOpen ? 'OPEN' : 'closed'}\n`);
    process.stdout.write(`  privacy: secrets ${snap.privacy_summary?.secret_correct ?? 0}/${snap.privacy_summary?.secret_total ?? 0}, paths ${snap.privacy_summary?.path_correct ?? 0}/${snap.privacy_summary?.path_total ?? 0}\n`);
    process.stdout.write(`  tests: ${snap.tests.passed ?? 0} passed, ${snap.tests.failed ?? 0} failed (${snap.tests.source})\n`);
    return 0;
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  return 2;
}

main().then((code) => process.exit(code ?? 0)).catch((e) => {
  process.stderr.write(`baseline error: ${e?.stack || e}\n`);
  process.exit(1);
});
