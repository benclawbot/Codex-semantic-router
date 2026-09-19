# Codex Semantic Router

A zero-NPM-dependency semantic pre-filter for Codex workflows. It reduces noisy context by classifying large candidate sets **before** they reach Codex, while retaining uncertain results and failing open when classification is unavailable.

The default backend is the public, keyless `classifier.dev` v1 API. No paid routing service, API key, account, MCP server, or background daemon is required.

## Why this exists

Coding agents often receive hundreds of search hits, CI lines, issue summaries, documentation snippets, or changed-file records even though only a small fraction matter. Once that bulk text is already in model context, a classifier cannot undo the cost.

Codex Semantic Router is designed for upstream use:

```text
large candidate set
        ↓
local secret/path checks
        ↓
classifier.dev fast batch classification
        ↓
keep relevant + uncertain
        ↓
Codex reads the smaller set
```

It is deliberately **not** a correctness oracle. Codex still plans, reasons, writes code, and performs authoritative verification.

## Requirements

- Node.js 20+
- Network access to `https://classifier.dev` for remote classification
- No npm dependencies

## Quick start

```bash
node skills/bulk-semantic-filter/scripts/router.mjs health

rg -n --no-heading "session|delete|remove" . \
  | node skills/bulk-semantic-filter/scripts/router.mjs filter \
      --goal "Find implementation and tests for deleting saved sessions"
```

By default, fewer than 8 candidates bypass remote classification. Automatic use never classifies fewer than 5. `--force` can bypass the size optimization but never bypasses privacy checks.

## Commands

### `filter`

Recall-first binary relevance filtering.

```bash
node skills/bulk-semantic-filter/scripts/router.mjs filter \
  --goal "Find root-cause compiler diagnostics" \
  < candidates.txt
```

A candidate is dropped only when it is classified `not relevant` with confidence at or above the configured threshold (default `0.80`). Relevant, low-confidence, null-confidence, sensitive, and otherwise unclassified records are retained.

### `tag`

Classify every eligible record without dropping it.

```bash
node skills/bulk-semantic-filter/scripts/router.mjs tag \
  --labels "compile error,test failure,environment,network,noise,other" \
  < diagnostics.txt
```

Use `--multi` when more than one label may apply.

### `count`

Return aggregate category counts without returning every individual classification.

```bash
node skills/bulk-semantic-filter/scripts/router.mjs count \
  --labels "bug,feature,docs,question,other" \
  < items.txt
```

### `uncertain`

Return records whose classification confidence is below a threshold, plus records that could not safely be classified remotely.

```bash
node skills/bulk-semantic-filter/scripts/router.mjs uncertain \
  --labels "bug,feature,docs,other" \
  --below 0.70 \
  < items.txt
```

### `health` and `config`

```bash
node skills/bulk-semantic-filter/scripts/router.mjs health
node skills/bulk-semantic-filter/scripts/router.mjs config
```

## JSONL input

```jsonl
{"id":"a1","text":"src/session/store.rs — delete_session removes persisted state","path":"src/session/store.rs"}
{"id":"a2","text":"README — how to delete sessions","path":"README.md"}
```

```bash
node skills/bulk-semantic-filter/scripts/router.mjs filter \
  --format jsonl \
  --goal "Find implementation code for deleting persisted sessions" \
  < items.jsonl
```

The complete object remains local. Only the selected text field is sent to the classifier. Use `--text-field nested.text` and `--id-field nested.id` for simple dotted paths.

## Privacy and remote egress

Remote classification is external processing. The router therefore blocks probable secrets before any network call.

Default sensitive-path protection covers `.env*`, SSH material, PEM/key files, credentials/secrets paths, AWS config, and gcloud config. The text scanner checks private-key markers, bearer headers, credential assignments, GitHub/AWS token patterns, JWT-like values, credential URLs, and secret-like `.env` assignments.

Sensitive records are **kept locally** and never sent remotely.

Disable remote classification for a repository:

`.codex/semantic-router.json`:

```json
{
  "remote": false
}
```

Or by environment:

```bash
export CODEX_SEMANTIC_ROUTER_REMOTE=0
```

`--offline` guarantees that the current invocation performs no remote classification.

## Fail-open behavior

Classifier availability must not become task availability. Backend timeouts, malformed responses, rate limits, local budgets, and an open circuit breaker all cause candidates to pass through rather than disappear.

The filter also has an all-dropped safety floor. If every classifiable candidate would be removed, it keeps up to three candidates with the highest returned `relevant` score when available; otherwise it keeps the full set.

## Configuration

Precedence, highest first:

1. CLI options
2. environment variables
3. repository `.codex/semantic-router.json`
4. user `~/.config/codex-semantic-router/config.json`
5. bundled `config/defaults.json`

Important defaults:

```json
{
  "remote": true,
  "tier": "fast",
  "endpoint": "https://classifier.dev/v1/classify",
  "min_items": 8,
  "batch_size": 250,
  "relevance_threshold": 0.8,
  "uncertain_threshold": 0.7,
  "max_input_chars": 8000,
  "request_timeout_ms": 5000,
  "max_retries": 1,
  "mode": "active"
}
```

Modes:

- `active` — filter normally.
- `shadow` — classify, but emit every original candidate for evaluation.
- `disabled` — skip remote classification.

## Cache, budget, and circuit breaker

The local cache stores only hashes plus classifier results; it never stores raw candidate input. Default TTL is one hour.

The router deliberately stays below the public backend budget with local limits of 2,000 candidate classifications/minute and 12,000/day. Reaching a local budget causes pass-through.

Three consecutive backend failures open the circuit breaker. During cooldown the router skips network calls and passes inputs through.

## Codex plugin / skill

This repository is a portable Agent Plugin:

```text
plugin.json
.codex-plugin/plugin.json
skills/bulk-semantic-filter/SKILL.md
```

The skill teaches Codex to pipe large local result sets through the router before reading them. No MCP server or Codex hooks are installed by default.

This design does **not** claim to prune the tool schemas Codex already received or remove the native initial skill metadata list. It focuses on bulk text that can actually be intercepted upstream.

## Test/build output

Never pipe a failing build/test command in a way that loses its exit status. Capture it first:

```bash
tmp="$(mktemp)"
set +e
some-test-command >"$tmp" 2>&1
code=$?
set -e

node skills/bulk-semantic-filter/scripts/router.mjs filter \
  --goal "Find root-cause errors, failed assertions, panics, compiler diagnostics, and actionable warnings" \
  <"$tmp"

exit "$code"
```

## Tests

```bash
npm test
```

Optional public-network smoke tests are off by default:

```bash
ALLOW_CLASSIFIER_NETWORK_TESTS=1 npm run test:network
```

Never place private repository data or real credentials in network tests.

## Full specification

See [`SPEC.md`](./SPEC.md) for the implementation rationale, architecture, acceptance criteria, and future work.

## License

MIT
