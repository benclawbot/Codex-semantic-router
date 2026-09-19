#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, sanitizedConfig } from './lib/config.mjs';
import { parseInput, clipText, InputParseError } from './lib/input.mjs';
import { inspectRecord } from './lib/redact.mjs';
import { Cache, buildCacheKey, dataDir, sha256 } from './lib/cache.mjs';
import { OperationalState, shouldKeep, applySafetyFloor } from './lib/policy.mjs';
import { ClassifierDevBackend, DisabledBackend, BackendError } from './lib/api.mjs';
import { diagnostic, renderRecord, routeMeta, writeLine } from './lib/output.mjs';

export const VERSION = '0.1.0';
export const GOAL_TEMPLATE_VERSION = 'goal-v1';

class CliError extends Error {}
class PolicyError extends Error {}

function parseNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliError(`${name} must be a number`);
  return number;
}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || ['-h', '--help', 'help'].includes(command)) return { command: 'help' };
  if (['-v', '--version', 'version'].includes(command)) return { command: 'version' };
  const out = { command };
  const valueOptions = new Map([
    ['--goal', 'goal'], ['--threshold', 'threshold'], ['--min-items', 'minItems'], ['--batch-size', 'batchSize'],
    ['--format', 'format'], ['--text-field', 'textField'], ['--id-field', 'idField'], ['--output', 'output'],
    ['--config', 'config'], ['--labels', 'labelsRaw'], ['--instructions', 'instructions'], ['--below', 'below'],
    ['--max-labels', 'maxLabels'], ['--endpoint', 'endpoint'], ['--mode', 'mode'],
    ['--max-input-chars', 'maxInputChars'], ['--reset-target', 'resetTarget']
  ]);
  const flags = new Map([
    ['--emit-classification', 'emitClassification'], ['--force', 'force'], ['--no-cache', 'noCache'],
    ['--offline', 'offline'], ['--multi', 'multi'], ['--strict-backend', 'strictBackend'],
    ['--explain', 'explain']
  ]);
  while (args.length) {
    const arg = args.shift();
    if (flags.has(arg)) { out[flags.get(arg)] = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (valueOptions.has(arg)) {
      if (!args.length) throw new CliError(`${arg} requires a value`);
      out[valueOptions.get(arg)] = args.shift();
      continue;
    }
    throw new CliError(`unknown option: ${arg}`);
  }
  if (out.threshold !== undefined) out.threshold = parseNumber(out.threshold, '--threshold');
  if (out.minItems !== undefined) out.minItems = parseNumber(out.minItems, '--min-items');
  if (out.batchSize !== undefined) out.batchSize = parseNumber(out.batchSize, '--batch-size');
  if (out.below !== undefined) out.below = parseNumber(out.below, '--below');
  if (out.maxLabels !== undefined) out.maxLabels = parseNumber(out.maxLabels, '--max-labels');
  if (out.maxInputChars !== undefined) out.maxInputChars = parseNumber(out.maxInputChars, '--max-input-chars');
  if (out.minItems !== undefined && !Number.isInteger(out.minItems)) throw new CliError('--min-items must be an integer');
  if (out.batchSize !== undefined && !Number.isInteger(out.batchSize)) throw new CliError('--batch-size must be an integer');
  if (out.maxLabels !== undefined && !Number.isInteger(out.maxLabels)) throw new CliError('--max-labels must be an integer');
  if (out.maxInputChars !== undefined && (!Number.isInteger(out.maxInputChars) || out.maxInputChars < 200 || out.maxInputChars > 32000)) throw new CliError('--max-input-chars must be an integer 200..32000');
  if (out.resetTarget !== undefined && !['cache', 'state', 'all'].includes(out.resetTarget)) throw new CliError('--reset-target must be cache, state, or all');
  return out;
}

function parseLabels(raw) {
  if (!raw) throw new CliError('--labels is required');
  const labels = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (labels.length < 2 || labels.length > 100) throw new CliError('--labels must contain 2..100 comma-separated labels');
  if (new Set(labels.map((x) => x.toLowerCase())).size !== labels.length) throw new CliError('--labels must be unique');
  return labels;
}

function helpText() {
  return `Codex Semantic Router ${VERSION}\n\n` +
`Usage:\n  router.mjs filter --goal <text> [options]\n  router.mjs tag --labels <a,b,...> [--multi] [options]\n  router.mjs count --labels <a,b,...> < items.txt\n  router.mjs uncertain --labels <a,b,...> [--below 0.70] < items.txt\n  router.mjs health [--offline]\n  router.mjs config [--config path]\n  router.mjs stats\n  router.mjs gc\n  router.mjs reset [--reset-target cache|state|all]\n\n` +
`Common options:\n  --format lines|jsonl      Input format (default: lines)\n  --text-field path         JSONL text field (default: text)\n  --id-field path           JSONL id field (default: id)\n  --output plain|jsonl      Output format\n  --force                   Classify even below min_items (never bypasses privacy)\n  --no-cache                Disable result cache\n  --offline                 Make no remote request\n  --config path             Additional JSON config\n  --strict-backend          Backend failure is nonzero instead of fail-open\n  --max-input-chars N       Override per-input char cap (200..32000)\n  --emit-classification     Add label/confidence prefix to plain output\n  --explain                 Add status/label/clipped prefix to plain output\n`;
}

async function readStdin(stdin) {
  if (typeof stdin === 'string') return stdin;
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data;
}

function buildGoalInstructions(goal) {
  return `${GOAL_TEMPLATE_VERSION}\nTask goal:\n${goal}\n\n` +
    `Classify each candidate only by whether it could materially help accomplish the task.\n` +
    `"relevant" includes implementation, call sites, tests, constraints, evidence, configuration, failure causes, or documentation likely needed to reason about the task.\n` +
    `"not relevant" means the candidate is very unlikely to help.\nDo not require exact keyword overlap.`;
}

function defaultOutput(command, format, explicit) {
  if (explicit) return explicit;
  if (command === 'filter') return format === 'jsonl' ? 'jsonl' : 'plain';
  return 'jsonl';
}

function candidateRecords(records) {
  return records.filter((record) => !record.blank);
}

function outputLines(stdout, lines) {
  if (!lines.length) return;
  stdout.write(lines.join('\n') + '\n');
}

function backendFor(config, fetchImpl) {
  if (!config.remote || config.mode === 'disabled') return new DisabledBackend();
  return new ClassifierDevBackend({
    endpoint: config.endpoint,
    tier: config.tier,
    batchSize: config.batch_size,
    maxConcurrency: config.max_concurrency,
    timeoutMs: config.request_timeout_ms,
    maxRetries: config.max_retries,
    maxRetryAfterMs: config.max_retry_after_ms,
    fetchImpl
  });
}

async function classifyEligible({ records, labels, instructions, multi = false, maxLabels, config, env, fetchImpl, stderr }) {
  const runtimeDir = dataDir(env);
  const cache = new Cache({ dir: runtimeDir, enabled: config.cache.enabled, ttlSeconds: config.cache.ttl_seconds });

  // Cache key is computed from ALL records (text + path) so we can hit the cache
  // before paying the inspect cost. The cached value stores the inspect outcomes,
  // so a hit lets us skip both inspect and the network call.
  const fullInputs = records.map((r) => `${r.path ?? ''}\0${r.text}`);
  const cacheKey = buildCacheKey({
    labels, instructions,
    inputs: fullInputs.map((s) => sha256(s)),
    config: { multi, maxLabels: maxLabels ?? null, tier: config.tier, template: GOAL_TEMPLATE_VERSION, endpoint: config.endpoint, relevance_threshold: config.relevance_threshold, uncertain_threshold: config.uncertain_threshold, max_input_chars: config.max_input_chars }
  });
  const cached = await cache.get(cacheKey);

  const inspectOutcomes = (cached?.inspect && Array.isArray(cached.inspect) && cached.inspect.length === records.length)
    ? cached.inspect
    : records.map((r) => inspectRecord(r, config.privacy));

  const safe = [];
  const local = [];
  records.forEach((r, i) => {
    if (inspectOutcomes[i].sensitive) local.push({ record: r, status: 'unclassified_sensitive', reason: inspectOutcomes[i].reason });
    else safe.push(r);
  });

  if (!safe.length) {
    if (!cached && config.cache.enabled) await cache.set(cacheKey, { results: [], inspect: inspectOutcomes });
    return { safe, local, inspect: inspectOutcomes, results: [], backendUsed: false, cacheHit: false };
  }

  const clipped = safe.map((record) => ({ record, ...clipText(record.text, config.max_input_chars) }));
  const inputs = clipped.map((item) => item.text);

  if (cached?.results?.length === safe.length) {
    return { safe, local, inspect: inspectOutcomes, clipped, results: cached.results, backendUsed: false, cacheHit: true };
  }

  if (!config.remote || config.mode === 'disabled') {
    return { safe, local: [...local, ...safe.map((record) => ({ record, status: 'unclassified_offline' }))], inspect: inspectOutcomes, clipped, results: null, backendUsed: false, cacheHit: false };
  }

  const state = new OperationalState({ dir: runtimeDir, config });
  await state.load();
  const permission = state.canClassify(safe.length);
  if (!permission.ok) {
    diagnostic(stderr, `backend skipped (${permission.reason}); passing candidates through`);
    return { safe, local: [...local, ...safe.map((record) => ({ record, status: `unclassified_${permission.reason}` }))], inspect: inspectOutcomes, clipped, results: null, backendUsed: false, cacheHit: false };
  }
  state.reserve(safe.length);
  await state.save();

  const backend = backendFor(config, fetchImpl);
  try {
    const response = multi
      ? await backend.classifyMulti({ inputs, labels, instructions, maxLabels })
      : await backend.classify({ inputs, labels, instructions });
    state.noteSuccess();
    await state.save();
    await cache.set(cacheKey, { results: response.results, inspect: inspectOutcomes, clipped: clipped.map((c) => ({ clipped: c.clipped })) });
    return { safe, local, inspect: inspectOutcomes, clipped, results: response.results, backendUsed: true, cacheHit: false };
  } catch (error) {
    const meta = error instanceof BackendError ? error : {};
    state.release(safe.length);
    state.noteFailure(meta);
    await state.save();
    throw error;
  }
}

function smallSet(config, options, candidates) {
  return !options.force && candidates.length < Math.max(5, config.min_items);
}

function routeForLocal(status) {
  return { status };
}

async function runFilter({ records, options, config, stdout, stderr, env, fetchImpl }) {
  if (!options.goal) throw new CliError('filter requires --goal');
  const candidates = candidateRecords(records);
  const output = defaultOutput('filter', options.format, options.output);
  if (smallSet(config, options, candidates) || config.mode === 'disabled') {
    const reason = config.mode === 'disabled' ? 'mode-disabled' : `below min_items=${config.min_items}`;
    for (const r of records) writeLine(stdout, renderRecord(r, { output }));
    diagnostic(stderr, `filter skipped (${reason}); ${candidates.length} candidates passed through`);
    return 0;
  }

  const instructions = buildGoalInstructions(options.goal);
  let classified;
  try {
    classified = await classifyEligible({ records: candidates, labels: ['relevant', 'not relevant'], instructions, config, env, fetchImpl, stderr });
  } catch (error) {
    if (options.strictBackend) throw new PolicyError(error.message);
    for (const r of records) writeLine(stdout, renderRecord(r, { output }));
    diagnostic(stderr, `backend failure; fail-open pass-through (${error.message})`);
    return 0;
  }

  if (!classified.results) {
    for (const r of records) writeLine(stdout, renderRecord(r, { output }));
    diagnostic(stderr, `filter pass-through; ${candidates.length} candidates, ${classified.local.length} unclassified locally`);
    return 0;
  }

  const resultByIndex = new Map();
  const clippedByIndex = new Map();
  classified.safe.forEach((record, i) => {
    resultByIndex.set(record.index, classified.results[i]);
    clippedByIndex.set(record.index, classified.clipped?.[i]?.clipped ?? false);
  });
  const localByIndex = new Map(classified.local.map((x) => [x.record.index, x]));
  const keptSafeIndexes = [];
  classified.safe.forEach((record, i) => {
    if (shouldKeep(classified.results[i], config.relevance_threshold)) keptSafeIndexes.push(i);
  });
  const keptCandidateIndexes = new Set(keptSafeIndexes.map((i) => classified.safe[i].index));
  for (const item of classified.local) keptCandidateIndexes.add(item.record.index);
  if (keptCandidateIndexes.size === 0 && classified.safe.length > 0) {
    const floor = applySafetyFloor(classified.safe, classified.results, [], 3);
    for (const i of floor) keptCandidateIndexes.add(classified.safe[i].index);
  }
  if (config.mode === 'shadow') for (const record of candidates) keptCandidateIndexes.add(record.index);

  let dropped = 0;
  let uncertain = 0;
  let retained = 0;
  for (const record of records) {
    if (record.blank) { writeLine(stdout, renderRecord(record, { output })); retained++; continue; }
    if (!keptCandidateIndexes.has(record.index)) { dropped++; continue; }
    const localStatus = localByIndex.get(record.index)?.status;
    const result = resultByIndex.get(record.index);
    if (result?.confidence == null || (result?.label === 'not relevant' && result?.confidence < config.relevance_threshold)) uncertain++;
    const route = localStatus
      ? routeForLocal(localStatus)
      : routeMeta(result, { clipped: clippedByIndex.get(record.index), emitScores: options.emitClassification });
    writeLine(stdout, renderRecord(record, { output, route, emitClassification: options.emitClassification, command: 'filter', explain: options.explain }));
    retained++;
  }
  diagnostic(stderr, `filter: ${candidates.length} candidates, ${retained} retained, ${dropped} dropped, ${uncertain} uncertain${classified.cacheHit ? ', cache hit' : ''}${config.mode === 'shadow' ? ', shadow mode' : ''}${options.explain ? ', explain' : ''}`);
  return 0;
}

async function runTagLike({ command, records, options, config, stdout, stderr, env, fetchImpl }) {
  const labels = parseLabels(options.labelsRaw);
  const candidates = candidateRecords(records);
  const output = defaultOutput(command, options.format, options.output);
  const threshold = options.below ?? config.uncertain_threshold;
  if (threshold < 0 || threshold > 1) throw new CliError('--below must be 0..1');
  if (options.multi && command !== 'tag') throw new CliError('--multi is only valid with tag');
  if (options.maxLabels != null && (options.maxLabels < 1 || options.maxLabels > 100)) throw new CliError('--max-labels must be 1..100');

  if (smallSet(config, options, candidates) || config.mode === 'disabled') {
    if (command === 'count') {
      stdout.write(JSON.stringify({ total: candidates.length, counts: {}, unclassified: candidates.length, reason: config.mode === 'disabled' ? 'mode-disabled' : 'below-min-items' }) + '\n');
    } else {
      for (const record of candidates) writeLine(stdout, renderRecord(record, { output, route: { status: 'unclassified_small_set' }, command }));
    }
    diagnostic(stderr, `${command} skipped; ${candidates.length} candidates`);
    return 0;
  }

  const instructions = options.instructions || `Classify each candidate according to the supplied labels. Use the closest label based on the content and task context. ${labels.some((x) => /other|none/i.test(x)) ? '' : 'The caller has not supplied an explicit other/none label; do not invent one.'}`;
  let classified;
  try {
    classified = await classifyEligible({ records: candidates, labels, instructions, multi: Boolean(options.multi), maxLabels: options.maxLabels, config, env, fetchImpl, stderr });
  } catch (error) {
    if (options.strictBackend) throw new PolicyError(error.message);
    if (command === 'count') stdout.write(JSON.stringify({ total: candidates.length, counts: {}, unclassified: candidates.length, backend_error: true }) + '\n');
    else for (const record of candidates) writeLine(stdout, renderRecord(record, { output, route: { status: 'unclassified_backend_error' }, command }));
    diagnostic(stderr, `backend failure; ${command} failed open (${error.message})`);
    return 0;
  }

  if (!classified.results) {
    if (command === 'count') stdout.write(JSON.stringify({ total: candidates.length, counts: {}, unclassified: candidates.length }) + '\n');
    else for (const record of candidates) writeLine(stdout, renderRecord(record, { output, route: { status: 'unclassified' }, command }));
    diagnostic(stderr, `${command}: no remote classification; ${candidates.length} candidates preserved`);
    return 0;
  }

  const resultByIndex = new Map();
  const clippedByIndex = new Map();
  classified.safe.forEach((record, i) => { resultByIndex.set(record.index, classified.results[i]); clippedByIndex.set(record.index, classified.clipped?.[i]?.clipped ?? false); });
  const localByIndex = new Map(classified.local.map((x) => [x.record.index, x.status]));

  if (command === 'count') {
    const counts = Object.fromEntries(labels.map((label) => [label, 0]));
    let unclassified = 0;
    for (const record of candidates) {
      const result = resultByIndex.get(record.index);
      if (!result) { unclassified++; continue; }
      if (options.multi) {
        for (const label of result.labels ?? []) counts[label] = (counts[label] ?? 0) + 1;
      } else if (result.label) counts[result.label] = (counts[result.label] ?? 0) + 1;
    }
    stdout.write(JSON.stringify({ total: candidates.length, counts, unclassified }) + '\n');
    diagnostic(stderr, `count: ${candidates.length} candidates, ${unclassified} unclassified${classified.cacheHit ? ', cache hit' : ''}`);
    return 0;
  }

  let emitted = 0;
  for (const record of candidates) {
    const localStatus = localByIndex.get(record.index);
    const result = resultByIndex.get(record.index);
    if (command === 'uncertain' && result && result.confidence != null && result.confidence >= threshold) continue;
    const route = localStatus
      ? routeForLocal(localStatus)
      : routeMeta(result, { clipped: clippedByIndex.get(record.index), emitScores: options.emitClassification });
    writeLine(stdout, renderRecord(record, { output, route, emitClassification: true, command, explain: options.explain }));
    emitted++;
  }
  diagnostic(stderr, `${command}: ${candidates.length} candidates, ${emitted} emitted${classified.cacheHit ? ', cache hit' : ''}${options.explain ? ', explain' : ''}`);
  return 0;
}

async function runStats({ stdout, env, config }) {
  const runtimeDir = dataDir(env);
  const cache = new Cache({ dir: runtimeDir, enabled: config.cache.enabled, ttlSeconds: config.cache.ttl_seconds });
  const state = new OperationalState({ dir: runtimeDir, config });
  await state.load();
  const now = Date.now();
  const circuitOpen = state.state.open_until > now;
  const cs = await cache.stats();
  const out = {
    runtime_dir: runtimeDir,
    cache: cs,
    cache_ttl_seconds: config.cache.ttl_seconds,
    circuit: {
      open: circuitOpen,
      open_until: state.state.open_until || null,
      consecutive_failures: state.state.consecutive_failures,
      last_failure_at: state.state.last_failure_at || null,
      cooldown_ms: config.circuit_breaker.cooldown_ms,
      failure_window_ms: config.circuit_breaker.failure_window_ms
    },
    budget: {
      minute_used: state.state.minute_count,
      minute_limit: config.budget.classifications_per_minute,
      minute_resets_in_ms: Math.max(0, 60_000 - (now - (state.state.minute_start || now))),
      day_used: state.state.day_count,
      day_limit: config.budget.classifications_per_day,
      day: state.state.day || new Date(now).toISOString().slice(0, 10)
    },
    mode: config.mode,
    remote: config.remote,
    backend: config.backend
  };
  stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

async function runReset({ options, env, config, stderr }) {
  const target = options.resetTarget || (options.cache ? 'cache' : options.state ? 'state' : 'all');
  const runtimeDir = dataDir(env);
  const cache = new Cache({ dir: runtimeDir, enabled: config.cache.enabled, ttlSeconds: config.cache.ttl_seconds });
  const summary = { target, runtime_dir: runtimeDir, cleared: {} };
  if (target === 'cache' || target === 'all') {
    summary.cleared.cache = await cache.clear();
  }
  if (target === 'state' || target === 'all') {
    const statePath = join(runtimeDir, 'state.json');
    if (existsSync(statePath)) await rm(statePath, { force: true });
    summary.cleared.state = { removed: 1 };
  }
  diagnostic(stderr, `reset ${target}: ${JSON.stringify(summary.cleared)}`);
  return summary;
}

async function runGc({ env, config, stdout, stderr }) {
  const runtimeDir = dataDir(env);
  const cache = new Cache({ dir: runtimeDir, enabled: config.cache.enabled, ttlSeconds: config.cache.ttl_seconds });
  const result = await cache.gc();
  diagnostic(stderr, `gc: ${JSON.stringify(result)}`);
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'help' || options.help) { stdout.write(helpText()); return 0; }
    if (options.command === 'version') { stdout.write(`${VERSION}\n`); return 0; }
    if (!['filter', 'tag', 'count', 'uncertain', 'health', 'config', 'stats', 'reset', 'gc'].includes(options.command)) throw new CliError(`unknown command: ${options.command}`);

    const config = await loadConfig({ cliOptions: options, cwd, env });
    if (options.command === 'config') { stdout.write(JSON.stringify(sanitizedConfig(config), null, 2) + '\n'); return 0; }
    if (options.command === 'health') {
      if (!config.remote || options.offline || config.mode === 'disabled') {
        stdout.write(JSON.stringify({ ok: false, disabled: true, service: 'classifier.dev' }) + '\n');
        return 0;
      }
      const backend = backendFor(config, fetchImpl);
      try { stdout.write(JSON.stringify(await backend.health()) + '\n'); return 0; }
      catch (error) {
        if (options.strictBackend) throw new PolicyError(error.message);
        stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
        return 0;
      }
    }
    if (options.command === 'stats') return await runStats({ stdout, env, config });
    if (options.command === 'gc') return await runGc({ env, config, stdout, stderr });
    if (options.command === 'reset') {
      const summary = await runReset({ options, env, config, stderr });
      stdout.write(JSON.stringify(summary) + '\n');
      return 0;
    }

    options.format = options.format || 'lines';
    if (!['lines', 'jsonl'].includes(options.format)) throw new CliError('--format must be lines or jsonl');
    if (options.output && !['plain', 'jsonl'].includes(options.output)) throw new CliError('--output must be plain or jsonl');
    options.textField = options.textField || 'text';
    options.idField = options.idField || 'id';
    const raw = await readStdin(stdin);
    const records = parseInput(raw, { format: options.format, textField: options.textField, idField: options.idField, stderr });
    if (options.command === 'filter') return await runFilter({ records, options, config, stdout, stderr, env, fetchImpl });
    return await runTagLike({ command: options.command, records, options, config, stdout, stderr, env, fetchImpl });
  } catch (error) {
    if (error instanceof CliError) { diagnostic(stderr, error.message); return 2; }
    if (error instanceof PolicyError) { diagnostic(stderr, error.message); return 3; }
    if (error instanceof InputParseError) { diagnostic(stderr, error.message); return 4; }
    diagnostic(stderr, `internal error: ${error?.stack || error}`);
    return 5;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
