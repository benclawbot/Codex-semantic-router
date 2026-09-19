# Codex Semantic Router — Zero-Cost Implementation Specification

**Status:** Implementation-ready specification  
**Version:** 1.0  
**Verified:** 2026-09-19  
**Primary target:** Codex CLI / IDE workflows with installable skills or plugins  
**External classifier:** `classifier.dev` v1, `fast` tier only by default  
**Additional paid services:** None  
**Runtime:** Node.js 20+ using only built-in modules  
**Default failure behavior:** Fail open to normal Codex behavior  
**Default privacy mode:** Metadata/snippets only; secret-bearing inputs are never sent remotely

---

## 1. Executive decision

Build **Codex Semantic Router** as a **skill-first, plugin-packaged, upstream semantic filtering layer**.

The implementation SHALL NOT add a paid routing dependency. It SHALL use `classifier.dev` only through its public, keyless v1 classification API and SHALL keep a no-op fallback so Codex continues normally whenever the classifier is unavailable, rate-limited, disabled, inappropriate, or disallowed by repository policy.

The core implementation SHALL be a zero-NPM-dependency Node.js CLI bundled inside a Codex skill:

```text
codex-semantic-router/
├── plugin.json
├── skills/
│   └── bulk-semantic-filter/
│       ├── SKILL.md
│       └── scripts/
│           ├── router.mjs
│           └── lib/
│               ├── api.mjs
│               ├── cache.mjs
│               ├── config.mjs
│               ├── input.mjs
│               ├── policy.mjs
│               ├── redact.mjs
│               └── output.mjs
├── config/
│   └── defaults.json
├── tests/
│   ├── api.test.mjs
│   ├── cache.test.mjs
│   ├── filter.test.mjs
│   ├── input.test.mjs
│   ├── policy.test.mjs
│   ├── redact.test.mjs
│   └── fixtures/
├── README.md
└── LICENSE
```

The MVP SHALL **not** register classifier.dev as an always-visible MCP server and SHALL **not** install Codex hooks by default.

That choice is deliberate:

1. The main benefit is avoiding context consumption. If Codex has already received a large search result, log, diff, issue list, or tool response, calling a classifier afterward cannot recover the context already spent.
2. A shell pipeline can filter bulk output *before* it crosses into Codex context.
3. Codex hooks such as `PreToolUse` occur after a tool has already been selected. They are useful for guardrails, not for reducing the initial tool catalog.
4. `PostToolUse` occurs after execution and is not a safe general-purpose way to rewrite arbitrary tool output.
5. Codex already uses progressive disclosure for skills and, on applicable API surfaces, native deferred tool search. The router should complement those capabilities, not duplicate them.
6. classifier.dev itself recommends classification when there are many items to avoid reading, and recommends simply deciding directly for small sets.

The central pattern is therefore:

```text
large candidate set
        │
        ▼
local deterministic cleanup/redaction
        │
        ▼
classifier.dev fast batch classification
        │
        ▼
keep relevant + uncertain candidates
        │
        ▼
Codex reads/reasons over the reduced set
```

Codex remains responsible for planning, coding, debugging, tool arguments, security decisions, and final verification.

---

## 2. Goals

The project SHALL optimize Codex workflows where many independent textual candidates exist and only a subset merits model attention.

Primary goals:

- Reduce unnecessary context consumption from repository searches, logs, test output, issues, PRs, docs, diffs, changelogs, and similar bulk text.
- Improve retrieval recall by retaining low-confidence classifications rather than aggressively discarding them.
- Add semantic filtering without another user-paid API.
- Require no classifier API key or account.
- Preserve normal Codex operation whenever classification fails.
- Avoid sending secrets or full sensitive source code by default.
- Remain portable across repositories and Codex installations.
- Be useful from a shell pipeline independently of Codex.
- Allow future backends without coupling the workflow to one service.
- Measure whether classification actually saves work before adding more invasive automation.
- Be explicit about what current Codex plugins/hooks can and cannot do.

---

## 3. Non-goals

The MVP SHALL NOT:

- Replace Codex reasoning.
- Decide whether code is correct or secure.
- Decide whether a PR is safe to merge.
- Skip required authoritative tests solely because a classifier says they are unnecessary.
- Auto-approve dangerous commands or permission prompts.
- Send secrets, credentials, private keys, `.env` values, or known secret files to a remote classifier.
- Parse undocumented Codex transcript formats.
- Claim to remove the initial Codex tool catalog in standard Codex CLI.
- Claim to reduce Codex's initial skill metadata list; Codex already constructs that list before a skill is selected.
- Require a paid model/API.
- Require classifier.dev's MCP server.
- Require an npm dependency.
- Install or download a local model in the MVP.
- Introduce a persistent background daemon.
- Make classification a mandatory dependency for task completion.

---

## 4. Research conclusions

### 4.1 classifier.dev is a good default backend

As verified on 2026-09-19, classifier.dev exposes a public, keyless v1 API with these properties relevant to this design:

- Up to **1,000 inputs per request**.
- **2–100 labels**.
- Up to **32,000 characters per input**.
- Single-label classification with a label, confidence, and per-label scores.
- Multi-label classification with independent per-label scores.
- `fast` and `smart` tiers.
- Public `fast` limits documented as **3,000 classifications/minute** and **20,000/day** per IP.
- Versioned stable endpoint: `POST https://classifier.dev/v1/classify`.
- 429 responses include `Retry-After`.
- The API is side-effect free and accepts an `Idempotency-Key`.
- No authentication is required.
- The service documents a policy of not storing request text in its analytics; request text still leaves the local machine and is processed remotely.

The implementation SHALL use `/v1/classify`, not the unversioned `/` alias.

The MVP SHALL use only `fast`. It does not need `smart`; Codex itself is the expensive reasoner. Low-confidence items should normally be retained for Codex rather than escalated to another remote reasoning pass.

### 4.2 The best unit is “candidate relevance,” not “choose one of 500 tools”

When evaluating a large set, the implementation SHOULD generally represent candidates as **inputs** and use a small semantic label set.

Preferred:

```json
{
  "inputs": [
    "skill: rust-debugging — Diagnose Rust compiler and borrow checker failures",
    "skill: figma-ui — Inspect and implement Figma UI",
    "skill: release-notes — Generate release notes"
  ],
  "labels": ["relevant", "not relevant"],
  "instructions": "Task: diagnose a Rust borrow-checker regression."
}
```

Avoid encoding hundreds of candidates as labels. The API permits only 100 labels, and binary relevance is easier to scale and calibrate.

This same pattern applies to:

- files
- grep/search matches
- tests
- skill descriptions
- tool descriptions
- issue summaries
- PR summaries
- documentation chunks
- logs
- diff hunks
- changelog entries
- dependency advisories
- review comments
- candidate semantic joins

### 4.3 False negatives cost more than false positives

For context filtering, incorrectly dropping the one relevant item can break the task. Keeping one extra item mostly costs context.

The default filter policy SHALL therefore be:

```text
KEEP if label == relevant
KEEP if confidence is null
KEEP if confidence < 0.80
DROP only if label == not relevant AND confidence >= 0.80
```

This intentionally biases toward recall.

The threshold SHALL be configurable.

### 4.4 Single-label classification needs a real “none” outcome when appropriate

classifier.dev's single-label endpoint always chooses one supplied label. Confidence is fit among the supplied labels; it is not an out-of-distribution detector.

Therefore any taxonomy in which none of the semantic choices may apply SHALL add a label such as:

```text
none of these
other
unrelated
not enough information
```

For binary relevance filtering, `not relevant` is already the explicit negative class.

### 4.5 Do not classify tiny sets by default

Remote classification is not useful when the model can already inspect a handful of visible candidates.

Default activation threshold:

```text
min_items = 8
```

Hard lower bound:

```text
never auto-classify fewer than 5 items
```

The user may explicitly invoke the router below that threshold for testing, but the Codex skill SHALL not recommend it automatically.

### 4.6 Hooks are not the main context-saving mechanism

Current Codex hooks include `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, and session lifecycle events.

However:

- `PreToolUse` sees a tool call after Codex has selected the tool.
- `PostToolUse` runs after supported tools return.
- A hook is not a general tool-schema search mechanism.
- `PreCompact`/`PostCompact` do not expose a documented stable transcript body suitable for arbitrary semantic pruning.
- Not every hosted/specialized tool path is covered by local tool hooks.
- Plugin hooks require explicit user trust.

Accordingly, hooks SHALL be optional later-stage guardrails, not the MVP architecture.

### 4.7 Skill selection already uses progressive disclosure

Codex begins with skill names/descriptions/paths, then loads full `SKILL.md` only after selecting a skill. The initial skill list has a bounded context budget; very large catalogs may have shortened or omitted descriptions.

A classifier can improve candidate ranking when supplied with a large external skill inventory, but a normal skill/plugin cannot retroactively remove the initial skill metadata Codex has already received.

Therefore:

- Skill relevance ranking is supported as an **advisory/retrieval mode**.
- The MVP SHALL NOT advertise skill ranking as an initial-context token reduction.
- Native Codex skill discovery remains authoritative.

### 4.8 Tool selection has a similar boundary

OpenAI's Responses API supports deferred tool search and BYOT tool search on supported API configurations. That is an appropriate place for true tool-schema pruning.

This specification targets normal Codex plugin/skill use and SHALL NOT assume that a plugin can replace Codex's tool search implementation.

For standard Codex:

- classifier-assisted tool catalog ranking is optional/advisory only when an external catalog is supplied;
- native deferred tool search should be preferred where the active Codex surface provides it;
- true BYOT tool-search integration is a future API-harness mode, not MVP.

---

## 5. Architecture

### 5.1 Layering

```text
L0  deterministic local policy
    - minimum candidate count
    - file/path exclusions
    - secret detection
    - payload size limits
    - exact filters
    - cache
            │
            ▼
L1  classifier backend
    - classifier.dev /v1/classify
    - fast tier
    - batch relevance/tagging
    - confidence
            │
            ▼
L2  retention/routing policy
    - keep relevant
    - keep uncertain
    - drop only confident negatives
    - preserve IDs and ordering
            │
            ▼
L3  Codex
    - reasoning
    - implementation
    - debugging
    - exact tool calls
    - review
            │
            ▼
L4  authoritative verification
    - compiler
    - tests
    - lint
    - typecheck
    - security tooling
    - CI
```

No classification result may override L0 hard security rules or L4 verification requirements.

### 5.2 Deployment model

The router SHALL first be implemented as a standalone Codex skill:

```text
skills/bulk-semantic-filter/
├── SKILL.md
└── scripts/
    └── ...
```

It SHALL then be packaged in a portable plugin for easier installation/distribution.

This follows the current Codex guidance: design the workflow as a skill; package it as a plugin when distribution is desired.

### 5.3 Why no MCP by default

classifier.dev has a valid remote MCP server and four useful tools. The project MAY document it as an optional manual integration, but SHALL NOT register it by default.

Reasons:

- If Codex first receives a large candidate set and then calls the classifier MCP tool, the context-saving opportunity has already been lost.
- An always-visible MCP server adds another capability Codex needs to consider.
- A pipeline CLI can consume search/log output before it reaches the model.
- The CLI can enforce local redaction and fail-open behavior before any network request.
- The CLI can expose exactly the retention semantics required by this project.

### 5.4 Why no mandatory hooks

The first version SHALL not include `hooks/hooks.json`.

This avoids:

- a trust prompt for unmanaged plugin hooks;
- per-tool classification latency;
- relying on unsupported hook-output mutation;
- intercepting only some tool paths;
- classifying single tool calls even though classifier.dev is most valuable for batches.

Hooks MAY be added in a later, separately enabled module after the core filtering value is measured.

---

## 6. Primary use cases

### 6.1 P0 — implement first

#### Repository search filtering

Use when a broad search produces many matches.

Example pattern:

```bash
rg -n --no-heading "session|delete|remove" . \
  | node /path/to/skills/bulk-semantic-filter/scripts/router.mjs filter \
      --goal "Find code responsible for deleting or clearing saved sessions"
```

Only relevant and uncertain lines are printed to Codex.

#### Candidate-file filtering

Generate compact records containing:

```text
path + symbol/heading + short snippet
```

Classify those instead of reading whole files.

#### CI/test log triage

Capture test output to a file, preserve the original exit code, then classify log records into useful categories or filter for likely causal diagnostics.

The router SHALL never turn a failed command into a successful one.

Recommended shell pattern:

```bash
tmp="$(mktemp)"
set +e
some-test-command >"$tmp" 2>&1
code=$?
set -e

node /path/to/router.mjs filter \
  --goal "Find root-cause errors, failed assertions, panics, compiler diagnostics, and actionable warnings" \
  <"$tmp"

exit "$code"
```

#### Search-result filtering

Any line/JSONL result list from local tools can be filtered before Codex reads all records.

#### Issue/PR candidate triage

When a local/connector wrapper can export issue or PR summaries to JSONL, classify summaries before fetching full bodies.

#### Documentation retrieval filtering

Classify title + heading + snippet, then open only retained pages/chunks.

#### Changelog/dependency release-note filtering

Retain entries likely to affect APIs, build behavior, security, runtime behavior, or explicitly used project functionality.

### 6.2 P1 — implement after core stability

#### Diff-file / diff-hunk triage

Classify changed files or hunks as:

- behavioral
- test
- documentation
- generated/mechanical
- configuration
- potentially security-sensitive
- other

This classification only determines review order. It does not decide correctness.

#### Test impact ordering

Given many test names/descriptions, classify which are likely affected by a change. Run likely tests early for feedback, but still run the required authoritative suite before completion.

#### Applicable-rule retrieval

Given many policy/rule descriptions and a task/change summary, retain rules semantically applicable to the task. Hard rules remain unconditional.

#### Skill relevance ranking

Given a supplied skill manifest with many skill descriptions, classify each skill as relevant/not relevant to the task.

This improves selection assistance; it does not reduce Codex's native initial skill-list budget.

#### Tool relevance ranking for external harnesses

Given an externally supplied tool manifest, classify tool descriptions as relevant/not relevant.

For standard Codex CLI this is advisory only. An API-level harness with native deferred tool search is a separate integration.

#### Requirement ↔ change candidate joins

Given preselected requirement/change pairs, classify whether each pair is likely related. Codex verifies retained pairs.

Do not generate the full Cartesian product for large sets; prefilter candidate pairs deterministically first.

### 6.3 P2 — experimental only

These SHALL be off by default:

- semantic intent-drift checks for selected high-risk tool calls;
- semantic permission annotations;
- subagent routing;
- stop/continue/replan hints;
- model/reasoning-effort hints;
- semantic context-obsolescence detection;
- prompt-injection suspicion tagging;
- generic tool-output replacement.

They should be added only if an evaluation demonstrates value without unacceptable latency or false negatives.

---

## 7. CLI specification

Executable entry point:

```text
node scripts/router.mjs <command> [options]
```

A future packaged binary or shell shim MAY expose:

```text
codex-semantic-router <command>
```

### 7.1 Commands

#### `filter`

Binary relevance filtering with recall-first retention.

```text
router.mjs filter --goal <text> [options]
```

Required:

- `--goal <text>`

Defaults:

- labels: `relevant`, `not relevant`
- threshold: `0.80`
- min items: `8`
- tier: `fast`
- input: newline-delimited text
- output: original retained records
- failure: emit original records unchanged

Options:

```text
--threshold <0..1>
--min-items <integer>
--format lines|jsonl
--text-field <json-path-lite>
--id-field <json-path-lite>
--output plain|jsonl
--emit-classification
--force
--no-cache
--offline
--config <path>
```

`--force` may bypass the `min-items` optimization check, but SHALL NOT bypass secret/sensitivity policy.

`--offline` SHALL perform no remote classification and SHALL pass all inputs through unchanged unless a local backend is explicitly installed/configured in a later version.

Retention:

```text
if result.label == "relevant":
    keep
elif result.confidence is null:
    keep
elif result.confidence < threshold:
    keep
else:
    drop
```

The command MUST preserve original order.

#### `tag`

Assign one category or multiple categories while preserving all records.

```text
router.mjs tag \
  --labels "compile error,test failure,environment,network,noise,other" \
  [--multi] \
  [--instructions "..."]
```

In single-label mode, `other` SHOULD be included unless the taxonomy is exhaustive.

Output SHALL include classification metadata and original record ID.

`tag` SHALL not drop records.

#### `count`

Return only aggregate category counts where individual classifications do not need to enter Codex context.

```text
router.mjs count \
  --labels "bug,feature,docs,question,other"
```

This is useful for corpus shape, not item selection.

#### `uncertain`

Return only records below a confidence threshold.

```text
router.mjs uncertain \
  --labels "category A,category B,other" \
  --below 0.70
```

This helps Codex inspect difficult cases while confident cases can remain outside context.

#### `health`

Check backend availability without sending repository content.

```text
router.mjs health
```

Use the documented classifier.dev health endpoint.

#### `config`

Print effective configuration with sensitive fields omitted.

```text
router.mjs config
```

### 7.2 Input formats

#### Lines

Each non-empty line is one candidate.

Blank lines MAY be retained locally but SHALL not be sent for classification.

Example:

```text
src/session/store.rs:91: pub fn delete_session(...)
src/ui/session_menu.tsx:48: const onDelete = ...
README.md:30: Delete a session from the menu
```

#### JSONL

Each line is one JSON object.

Example:

```json
{"id":"a1","text":"src/session/store.rs — delete_session removes persisted session state","path":"src/session/store.rs"}
{"id":"a2","text":"README — instructions for deleting sessions","path":"README.md"}
```

The router SHALL preserve the entire original object locally but SHALL send only the selected `text` field to classifier.dev.

Default JSONL fields:

```text
id-field   = id
text-field = text
```

If no ID is supplied, assign an ephemeral zero-based sequence ID without persisting the input.

### 7.3 Output

Machine-readable output SHOULD default to JSONL when input is JSONL.

Example:

```json
{
  "id": "a1",
  "text": "src/session/store.rs — delete_session removes persisted session state",
  "route": {
    "label": "relevant",
    "confidence": 0.96
  }
}
```

By default the CLI SHALL NOT expose the full `scores` map to Codex, because that creates unnecessary output. `--emit-classification` may include it.

For line input, default output is original retained lines only. Diagnostic/status information MUST go to `stderr`, never `stdout`, so shell pipelines remain composable.

### 7.4 Exit codes

```text
0  successful router operation, including fail-open pass-through
2  invalid CLI arguments/config
3  local security/policy refused a requested remote operation
4  input parse failure in strict mode
5  internal router bug
```

A remote classifier failure SHALL NOT produce a nonzero exit by default because it must fail open.

With explicit `--strict-backend`, backend failure MAY exit nonzero. Codex skill instructions SHALL not use strict mode.

---

## 8. classifier.dev client contract

### 8.1 Endpoint

```text
POST https://classifier.dev/v1/classify
```

Headers:

```http
Content-Type: application/json
Accept: application/json
User-Agent: codex-semantic-router/0.1
Idempotency-Key: <sha256 request fingerprint>
```

The client SHALL set a real User-Agent. classifier.dev documentation notes that default Python `urllib` user agents may be blocked; Node's built-in `fetch` still SHOULD set an explicit project user agent.

### 8.2 Single-label request

```json
{
  "inputs": [
    "src/session/store.rs:91: pub fn delete_session(...)",
    "README.md:30: Delete a session from the menu"
  ],
  "labels": ["relevant", "not relevant"],
  "instructions": "Goal: Find implementation code responsible for deleting persisted sessions. Relevant means likely to contain implementation, state mutation, call sites, tests, or constraints needed to solve the task.",
  "tier": "fast"
}
```

### 8.3 Expected response fields

The client SHALL depend only on:

```text
results[].label
results[].confidence
results[].scores   (optional for diagnostics/ranking)
usage              (optional)
```

Unknown additive fields SHALL be ignored.

Response order SHALL be assumed to match input order, as documented by classifier.dev.

### 8.4 Multi-label request

For tagging:

```json
{
  "inputs": ["..."],
  "labels": [
    "compiler diagnostic",
    "failed test assertion",
    "environment problem",
    "network problem",
    "likely secondary error"
  ],
  "instructions": "...",
  "multi": true,
  "max_labels": 3
}
```

When custom thresholds are needed, the implementation SHOULD use the returned independent score map rather than rely only on the server's default returned-label cutoff.

### 8.5 Batching

Hard service maximum:

```text
1,000 inputs/request
```

Router default:

```text
batch_size = 250
```

Rationale: smaller batches limit retry blast radius and memory while still amortizing network overhead. The value SHALL be configurable up to 1,000.

The client SHALL preserve global ordering while combining batch responses.

### 8.6 Input clipping

The remote API accepts up to 32,000 characters per input, but sending that much source for routing is usually counterproductive.

Default:

```text
max_input_chars = 8,000
```

For larger candidates:

- preserve the first portion and last portion;
- insert an explicit marker such as `[… locally clipped …]`;
- record `clipped: true` in local metadata;
- never silently truncate.

Recommended split:

```text
first 6,000 chars + marker + last 2,000 chars
```

For source files, callers SHOULD create purpose-built snippets instead of passing whole files.

### 8.7 Timeouts and retries

Defaults:

```text
request_timeout_ms = 5000
max_retries = 1
```

Retry once on:

- transient network failure;
- HTTP 502;
- HTTP 503;
- HTTP 504.

For HTTP 429:

- read `Retry-After`;
- if the indicated wait is <= configured `max_retry_after_ms`, retry once;
- otherwise fail open immediately and open the circuit breaker.

Do not retry:

- 400-series input errors other than 429;
- policy refusals;
- parse errors caused by malformed local input.

### 8.8 Circuit breaker

Persist only operational state, not payload content.

Default:

```text
failure_window = 5 minutes
open_after = 3 consecutive backend failures
cooldown = 10 minutes
```

While open:

- do not make network calls;
- pass candidates through;
- emit one concise `stderr` diagnostic per process.

429/day-limit responses SHOULD open the breaker until the next reasonable reset boundary if provided, otherwise for one hour.

---

## 9. Local privacy and security policy

### 9.1 Principle

classifier.dev is a remote service. Even though its public code/documentation states request text is not stored in analytics, sending content still causes network egress.

Therefore the router SHALL treat remote classification as disclosure to an external processor.

### 9.2 Default payload policy

```text
network_payload_policy = metadata_and_snippets
```

Allowed by default:

- filenames
- paths excluding obviously secret paths
- symbol names
- test names
- issue titles
- PR titles
- short error lines
- short search snippets
- short documentation snippets
- short diff summaries produced locally

Not allowed by default:

- `.env` contents
- private keys
- credentials
- API tokens
- cookies
- authentication headers
- password files
- SSH keys
- cloud credentials
- signing keys
- arbitrary full repository files
- binary data
- user-designated confidential paths

### 9.3 Secret detector

Before any remote call, scan candidate text using deterministic local patterns.

Minimum detectors:

- PEM private key headers
- common API-key/token prefixes
- `Authorization: Bearer`
- `password=`, `passwd=`, `secret=`, `token=` assignments
- AWS-style access key patterns
- GitHub token prefixes
- common `.env` key/value shapes
- SSH private-key markers
- JWT-like tokens
- high-confidence credential URL forms
- configured organization-specific patterns

The detector MUST prefer false positives over secret egress.

If one record appears secret-bearing:

```text
do not send that record
keep it locally as "unclassified_sensitive"
```

Do not discard it.

### 9.4 Sensitive paths

Default deny patterns SHOULD include:

```text
.env
.env.*
**/.ssh/**
**/*id_rsa*
**/*id_ed25519*
**/*.pem
**/*.key
**/credentials*
**/secrets*
**/.aws/**
**/.config/gcloud/**
```

Repositories may extend the list.

The presence of a path named `secrets` is not proof that content is secret; however, the safe default is to skip remote classification for it.

### 9.5 Repository opt-out

The router SHALL look for a repository-local policy file before any network call:

```text
.codex/semantic-router.json
```

Supported hard opt-out:

```json
{
  "remote": false
}
```

When `remote:false`, pass all candidates through unless a future local backend is explicitly enabled.

Environment override:

```text
CODEX_SEMANTIC_ROUTER_REMOTE=0
```

Environment opt-out SHALL take precedence over repository config.

### 9.6 Logging

Never log raw candidate text by default.

Local operational logs may include:

- timestamp
- command
- candidate count
- retained count
- dropped count
- uncertain count
- latency
- HTTP status
- cache hit/miss
- error code

No raw labels generated from private user text should be persisted unless they come from static configured taxonomies.

---

## 10. Configuration

Configuration precedence, highest first:

```text
CLI arguments
environment variables
repository .codex/semantic-router.json
user config ~/.config/codex-semantic-router/config.json
bundled defaults
```

The user-config path MAY later be made platform-aware.

Default configuration:

```json
{
  "backend": "classifier_dev",
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
  "max_retry_after_ms": 3000,
  "cache": {
    "enabled": true,
    "ttl_seconds": 3600,
    "store_raw_inputs": false
  },
  "budget": {
    "classifications_per_minute": 2000,
    "classifications_per_day": 12000
  },
  "privacy": {
    "payload_policy": "metadata_and_snippets",
    "block_probable_secrets": true
  },
  "mode": "active"
}
```

The local budget deliberately stays below the current public backend limits to preserve headroom.

`mode` values:

```text
active
shadow
disabled
```

`shadow` performs classification but emits every original candidate. It records aggregate metrics only. This is intended for evaluation.

---

## 11. Cache

### 11.1 Purpose

Avoid repeated remote classification of identical candidate sets during iterative Codex work.

### 11.2 Key

```text
SHA-256(
  backend version identifier
  + normalized labels
  + normalized instructions
  + normalized candidate text hashes
  + relevant config thresholds
)
```

The key MAY contain hashes of candidate text but SHALL NOT contain raw text.

### 11.3 Value

Allowed cached value:

```json
{
  "created_at": "...",
  "api_version": "v1",
  "results": [
    {"label":"relevant","confidence":0.93},
    {"label":"not relevant","confidence":0.91}
  ]
}
```

Do not persist candidate text.

### 11.4 Location

When running as a plugin/hook with `PLUGIN_DATA`, use that writable directory.

For skill CLI use outside hooks:

```text
~/.cache/codex-semantic-router/
```

Repository-local cache files SHALL NOT be created unless explicitly configured.

### 11.5 Invalidating

Invalidate on:

- TTL expiry;
- backend major version change;
- label/instruction change;
- candidate hash change;
- relevant configuration change.

---

## 12. Codex skill specification

Path:

```text
skills/bulk-semantic-filter/SKILL.md
```

Front matter:

```yaml
---
name: bulk-semantic-filter
description: Filter or tag large textual candidate sets before Codex reads them. Use for 8+ search matches, log/test records, issue/PR summaries, docs snippets, changed-file summaries, or similar bulk text when only a subset is useful. Do not use for small sets already visible in context.
---
```

The skill SHALL teach these rules:

1. Use the router only when there are at least 8 independent candidates, unless explicitly requested.
2. Prefer piping command output directly into the router so raw bulk output never reaches Codex context.
3. Supply a concrete goal, not vague labels.
4. Keep low-confidence results.
5. Never use the router to certify correctness or security.
6. Never pass secrets or private full-file contents remotely.
7. If the router reports backend failure, continue with normal local tools.
8. Preserve authoritative command exit status when filtering test/build output.
9. For multi-category tagging, include `other` or `none of these` unless the taxonomy is exhaustive.
10. Use native Codex reasoning directly for a handful of candidates.

The skill SHALL include examples for:

- `rg` filtering;
- test-log triage;
- changed-file triage;
- documentation candidate filtering;
- JSONL issue-summary filtering.

The skill SHALL refer to its bundled `scripts/router.mjs` using a path relative to the loaded skill directory. No global installation should be required for functionality.

---

## 13. Skill-selection support

### 13.1 What is possible

The CLI MAY expose:

```text
router.mjs filter --goal "<task>"
```

against an externally supplied JSONL catalog such as:

```json
{"id":"rust-debug","text":"Rust debugging — compiler, borrow checker and runtime failures"}
{"id":"figma","text":"Inspect Figma designs and implement UI"}
```

This can rank a large skill catalog semantically.

### 13.2 What it does not do

In normal Codex skill/plugin operation, this does not reduce the metadata Codex already received for its initial skill list.

Therefore the feature SHALL be documented as:

```text
selection assistance / external catalog retrieval
```

not:

```text
initial skill-context pruning
```

### 13.3 Recommended threshold

Use skill-ranking only for a large catalog, e.g.:

```text
>= 25 candidate skill descriptions
```

Native Codex selection is sufficient for ordinary catalogs.

---

## 14. Tool-selection support

### 14.1 Standard Codex CLI

The MVP SHALL NOT claim to hide or defer tool schemas through a plugin.

A `PreToolUse` hook is too late for that purpose: the model has already selected the tool.

### 14.2 External/API harness

A later implementation MAY use the same relevance engine as a tool-search backend where the calling OpenAI API surface supports deferred/BYOT tool search.

That mode is outside this zero-additional-cost Codex CLI MVP because:

- it requires a custom API harness;
- API usage may have its own billing;
- the standard plugin does not control Codex's internal tool catalog.

### 14.3 Tool-result filtering

The preferred near-term tool optimization is to wrap **local bulk-producing commands** so the router filters their output before Codex sees it.

For arbitrary MCP tool responses, generic safe pre-context interception is not currently an MVP feature.

---

## 15. Optional hooks — future module

Hooks SHALL be absent from the initial plugin package. If later added, they MUST be explicitly documented and separately enabled.

### 15.1 `PreToolUse` semantic guard

Potential use:

- only on a configured set of consequential tools/commands;
- deterministic rules first;
- classifier only when policy is ambiguous;
- result may add context/warning;
- never auto-allow a permission solely because the classifier says it looks safe.

Because this is a single-item classification and adds latency, it is an experimental feature, not a default.

### 15.2 `PermissionRequest`

Do not use the classifier as an approval authority.

Allowed design:

- hard deterministic policy may deny;
- semantic classifier may annotate uncertainty;
- normal Codex/user permission flow remains authoritative.

### 15.3 `PostToolUse`

Do not generically replace arbitrary tool results.

Potential future use only for known, structured, explicitly supported tools where:

- output schema is known;
- replacement behavior is tested;
- original exit/effect semantics are preserved.

### 15.4 `PreCompact` / `PostCompact`

Do not parse undocumented transcript formats to implement semantic memory pruning.

Future compaction integration should wait for a documented stable context/transcript interface.

---

## 16. Failure semantics

The router's core rule:

```text
optimization failure must not become task failure
```

### 16.1 Backend unavailable

Action:

```text
emit all original candidates unchanged
```

### 16.2 Rate-limited

Action:

- optionally retry once if `Retry-After` is short;
- otherwise open circuit breaker;
- emit all original candidates.

### 16.3 Low confidence

Action:

```text
keep
```

### 16.4 Null confidence / non-natural-language

Action:

```text
keep
```

### 16.5 Malformed backend response

Action:

```text
emit all original candidates
record operational error
```

### 16.6 Secret detected

Action:

```text
do not send candidate remotely
keep candidate
mark local status sensitive
```

### 16.7 Candidate count below threshold

Action:

```text
skip network call
emit all candidates
```

### 16.8 Classifier says everything is irrelevant

Safety floor:

If every candidate would be dropped, retain at least:

```text
top_k_fallback = min(3, candidate_count)
```

based on highest `relevant` score where available, otherwise retain all.

This protects against a badly framed goal or taxonomy.

---

## 17. Local budget management

Track counts locally to avoid unexpectedly exhausting the public service quota.

Use a rolling local state file containing only counters/timestamps.

Defaults:

```text
2,000 classifications/minute
12,000 classifications/day
```

Once a local budget is reached:

```text
pass through until reset
```

The budget applies to **candidate classifications**, not HTTP requests.

No billing or API key logic is required.

---

## 18. Implementation modules

### 18.1 `router.mjs`

Responsibilities:

- parse CLI;
- load config;
- read input;
- apply local policy;
- call backend;
- apply retention policy;
- emit output;
- preserve failure semantics.

It should contain orchestration only.

### 18.2 `lib/api.mjs`

Responsibilities:

- build v1 requests;
- set headers;
- timeout;
- retry;
- parse rate-limit headers;
- validate minimum response shape;
- expose `classify()` and `classifyMulti()`.

Public internal interface:

```js
class ClassifierBackend {
  async classify({ inputs, labels, instructions }) {}
  async classifyMulti({ inputs, labels, instructions, maxLabels }) {}
  async health() {}
}
```

Implement:

```text
ClassifierDevBackend
DisabledBackend
```

A future local backend must conform to the same interface.

### 18.3 `lib/input.mjs`

Responsibilities:

- line input;
- JSONL input;
- IDs;
- selected text field;
- clipping;
- blank input handling;
- stable order.

### 18.4 `lib/policy.mjs`

Responsibilities:

- min-item threshold;
- retention decision;
- all-dropped safety floor;
- local budget;
- repository opt-out;
- experimental feature flags.

### 18.5 `lib/redact.mjs`

Responsibilities:

- secret detection;
- path-sensitive exclusions;
- optional local replacement of obvious secrets in otherwise safe snippets.

Default behavior should be **skip remote classification for the whole affected record**, not attempt clever partial redaction when certainty is low.

### 18.6 `lib/cache.mjs`

Responsibilities:

- hash-only keys;
- no raw-input persistence;
- TTL;
- atomic writes;
- corrupt-cache recovery.

### 18.7 `lib/output.mjs`

Responsibilities:

- stdout data;
- stderr diagnostics;
- JSONL/line rendering;
- no accidental raw-input logging.

### 18.8 `lib/config.mjs`

Responsibilities:

- precedence;
- schema validation;
- bounds validation;
- environment overrides;
- safe defaults.

Use no third-party validation package.

---

## 19. Pseudocode

### 19.1 Filter

```text
records = read_input()

if records.count < min_items and not force:
    emit(records)
    exit 0

safe = []
passthrough = []

for record in records:
    if remote_disabled:
        passthrough += record
    else if is_sensitive(record):
        passthrough += record
    else:
        safe += record

if safe is empty:
    emit_in_original_order(passthrough)
    exit 0

results = classify_or_fail_open(
    inputs = clipped_text(safe),
    labels = ["relevant", "not relevant"],
    instructions = build_goal_instructions(goal)
)

if backend_failed:
    emit(records)
    exit 0

for each safe record + result:
    if result.label == "relevant":
        keep
    else if result.confidence is null:
        keep
    else if result.confidence < threshold:
        keep
    else:
        drop

merge passthrough + kept by original order

if merged is empty:
    apply top-k safety floor

emit merged
```

### 19.2 Goal instruction

Use a stable template:

```text
Task goal:
<goal>

Classify each candidate only by whether it could materially help accomplish the task.
"relevant" includes implementation, call sites, tests, constraints, evidence,
configuration, failure causes, or documentation likely needed to reason about the task.
"not relevant" means the candidate is very unlikely to help.
Do not require exact keyword overlap.
```

This template should be versioned because changing it changes behavior/cache validity.

---

## 20. Practical Codex workflows

### 20.1 Repository exploration

Bad:

```bash
rg -n "session" .
```

when it returns hundreds of lines directly into Codex.

Better:

```bash
rg -n --no-heading "session" . \
  | node /path/to/router.mjs filter \
      --goal "Find implementation and tests for deleting recent sessions"
```

Then Codex opens only retained files.

### 20.2 Build/test failure triage

Preferred:

```bash
tmp="$(mktemp)"
set +e
cargo test --workspace >"$tmp" 2>&1
code=$?
set -e

grep -E 'error|fail|panic|warning|caused by|assert' "$tmp" \
  | node /path/to/router.mjs tag \
      --labels "root-cause candidate,secondary failure,environment,warning,other" \
      --instructions "Classify diagnostics from this failed test run."

exit "$code"
```

This preserves the authoritative test result.

### 20.3 Changed-file review order

```bash
git diff --name-status main...HEAD \
  | node /path/to/router.mjs tag \
      --labels "behavioral code,test,documentation,generated or mechanical,configuration,other"
```

Codex may inspect behavioral/configuration changes first, but must still review as required.

### 20.4 Documentation search

Pipe titles/headings/snippets into:

```bash
node router.mjs filter \
  --goal "Find documentation explaining Codex PreToolUse hook output fields"
```

Open only retained documents.

### 20.5 Skill catalog ranking

Given a JSONL export of many skill descriptions:

```bash
node router.mjs filter \
  --format jsonl \
  --goal "Diagnose a Windows-only Rust process containment test failure"
```

Treat output as candidate skills for Codex to inspect, not as a forced selection.

---

## 21. Evaluation and rollout

### 21.1 Start in shadow mode

Before aggressive filtering in an important workflow:

```json
{"mode":"shadow"}
```

Shadow mode:

- sends eligible candidates;
- computes classifications;
- emits all candidates unchanged;
- stores aggregate metrics only.

Compare classifier predictions against which candidates Codex actually uses.

### 21.2 Metrics

Collect only non-content metrics:

```text
candidate_count
classified_count
retained_count
dropped_count
uncertain_count
sensitive_passthrough_count
backend_latency_ms
cache_hit
backend_error_code
```

Optional evaluation labels may be generated manually after sessions:

```text
useful_candidate_was_dropped
irrelevant_candidate_was_kept
```

### 21.3 Success criteria before enabling active filtering broadly

Suggested:

- false-negative rate on known-needed candidates < 1%;
- backend failure always passes inputs through;
- no detected secret leaves the machine;
- median retained set <= 50% of candidate set on workloads where filtering is useful;
- median classification overhead acceptable relative to context saved;
- no change to authoritative command exit status;
- no required task blocked by classifier availability.

### 21.4 Do not optimize only for precision

The router's objective is not maximum classification accuracy.

Primary objective:

```text
high recall of useful candidates
+
meaningful reduction of obvious noise
```

---

## 22. Test plan

Use Node's built-in `node:test`; no third-party test framework.

### 22.1 Unit tests

#### Input

- line parsing
- JSONL parsing
- blank lines
- malformed JSONL
- stable IDs
- clipping
- Unicode
- very long lines

#### Retention

- relevant/high confidence kept
- relevant/low confidence kept
- negative/low confidence kept
- negative/high confidence dropped
- null confidence kept
- all-negative safety floor
- original order retained

#### Redaction

- PEM keys
- bearer tokens
- `.env` values
- GitHub token patterns
- AWS-like keys
- JWT-like strings
- benign high-entropy strings
- sensitive path rules

Every sensitive record must remain in local output but must be absent from mocked HTTP request bodies.

#### API

- correct `/v1/classify`
- correct User-Agent
- `fast` tier
- batching
- response ordering
- 429 + Retry-After
- 502 retry
- timeout
- malformed JSON
- missing `results`
- result count mismatch
- additive unknown response fields ignored

#### Cache

- hash key changes with goal/input/config
- no raw text in cache
- TTL
- corrupt cache
- atomic write
- disabled cache

#### Budget/circuit breaker

- minute budget
- daily budget
- three failures open circuit
- cooldown closes circuit
- rate limit opens appropriate circuit

### 22.2 Golden CLI tests

Verify exact stdout/stderr separation.

For example:

```text
stdin: 10 records
backend: 2 relevant, 5 confident negative, 3 uncertain
stdout: 5 original records
stderr: one summary line
exit: 0
```

### 22.3 Network integration test

Disabled by default.

Enable only with:

```text
ALLOW_CLASSIFIER_NETWORK_TESTS=1
```

Tests:

- health endpoint;
- two-label classification;
- batch response order;
- no authentication required.

Never use real repository secrets or private code in network tests.

### 22.4 Codex integration test

Create a fixture repository containing:

- 100 irrelevant search matches;
- 5 relevant implementation/test matches;
- known target files.

Task:

```text
Find and explain the code responsible for deleting a saved session.
```

Compare:

```text
native broad search
vs
pipeline semantic filter
```

Measure:

- number of raw search lines entering Codex;
- relevant target recall;
- extra latency;
- task success.

---

## 23. Acceptance criteria

The MVP is complete when all of the following are true:

- No paid external classifier/API is required.
- No classifier account or API key is required.
- Node runtime has zero npm dependencies.
- Stable v1 endpoint is used.
- `fast` is the default and only required tier.
- Fewer than 8 candidates skip the network by default.
- Secret-bearing records never enter remote request bodies in tests.
- Low-confidence negatives are retained.
- Backend failures pass all candidates through.
- Results preserve original ordering.
- Classifier response count mismatch fails open.
- 429 is handled without task failure.
- Test/build command exit codes are never rewritten by the router.
- The skill explicitly teaches filtering *before* bulk output reaches Codex.
- The plugin does not register an MCP server by default.
- The plugin does not install hooks by default.
- Documentation does not claim standard Codex plugins can prune the initial tool catalog.
- Documentation does not claim skill routing removes Codex's initial skill metadata.
- Required verification is never skipped solely due to classification.
- Unit and golden tests pass on Linux, macOS, and Windows where Node 20+ is available.

---

## 24. Implementation phases

### Phase 1 — core CLI

Implement:

- line/JSONL input;
- config;
- redaction;
- classifier.dev v1 client;
- batching;
- relevance filter;
- fail-open behavior;
- cache;
- budget;
- tests.

Deliverable:

```text
node router.mjs filter ...
```

### Phase 2 — Codex skill

Implement `SKILL.md` with upstream-pipeline usage and examples.

Validate that Codex triggers the skill for large search/log/result tasks but not for ordinary small tasks.

### Phase 3 — plugin packaging

Package the skill in a portable plugin manifest.

Do not add MCP or hooks.

### Phase 4 — expanded commands

Add:

- tag
- count
- uncertain
- changed-file recipes
- test-log recipes
- JSONL adapters

### Phase 5 — evaluation

Run shadow and active comparisons on real repositories.

Tune:

- `min_items`
- relevance threshold
- clipping
- batching
- goal template

### Phase 6 — optional advanced integrations

Only after evidence:

- external skill catalog ranking;
- externally supplied tool catalog ranking;
- applicable-rule retrieval;
- semantic joins;
- targeted hooks;
- optional local backend.

---

## 25. Optional local/offline backend

A local backend is not required for MVP, but the backend interface SHALL make it possible.

A reasonable future candidate is an open-weight zero-shot NLI/classification model such as the ModernBERT zero-shot family. Current public model artifacts include relatively compact ONNX/int8 variants, but adding one would introduce:

- model download size;
- ONNX/runtime dependency;
- CPU/RAM load;
- platform packaging work;
- tokenizer/runtime maintenance;
- potentially different confidence calibration.

Therefore the default architecture is:

```text
classifier.dev when remote classification is allowed
otherwise fail open
```

not:

```text
silently download a local model
```

A local backend must be an explicit installation choice.

---

## 26. Known limitations

- The hosted classifier is a network dependency even though it does not require payment or an API key.
- Service limits or terms may change; fail-open behavior is mandatory.
- Semantic classification is probabilistic.
- Confidence is not an out-of-distribution detector.
- Filtering can only save context when placed upstream of Codex input.
- Native Codex skill metadata still exists before this skill is selected.
- Standard Codex plugins do not provide a general documented mechanism to replace the initial tool catalog with classifier-selected schemas.
- Generic MCP output interception is not implemented.
- Classification of one action at a time often costs more latency than it saves.
- Remote filtering may be inappropriate for confidential repositories unless payloads are safe metadata/snippets.
- A relevance classifier cannot replace compiler/test/security evidence.

---

## 27. Explicitly rejected designs

### Always-visible classifier MCP as the primary implementation

Rejected for MVP because it often acts after large input is already in Codex context and does not guarantee context savings.

### Classifier call on every user prompt

Rejected because one prompt is a tiny batch, adds latency, and Codex can reason about it directly.

### Classifier call on every tool action

Rejected because it is usually one item, happens after tool selection, and creates latency without enough batch leverage.

### Generic PostToolUse output replacement

Rejected because it is difficult to make safe across arbitrary tool schemas and effects.

### Semantic auto-approval

Rejected. Permission/security authority remains deterministic/user/Codex policy.

### Classifier-based final correctness decision

Rejected. Authoritative tests and analysis remain required.

### Mandatory local model

Rejected for MVP because the setup/runtime cost is large relative to a free keyless backend and a fail-open path.

---

## 28. Reference implementation details to preserve

These are invariants, not tuning suggestions:

```text
API path                         /v1/classify
default tier                     fast
default labels for filter        relevant / not relevant
default min items                8
hard automatic lower bound       5
default keep threshold           0.80
null confidence                  keep
backend error                    keep all
sensitive candidate              do not send; keep
all candidates classified drop   retain safety-floor candidates
cache raw text                   never by default
remote secret egress             forbidden
MCP registration                 none by default
Codex hooks                      none by default
npm dependencies                 zero
```

---

## 29. Double-check checklist for the implementer

Before merging implementation, verify:

- [ ] `/v1/classify` is used rather than relying on the unversioned alias.
- [ ] `User-Agent` is explicit.
- [ ] `tier:"fast"` is present or safely defaulted.
- [ ] No API key is expected.
- [ ] More than 100 labels are rejected locally.
- [ ] More than configured batch size is split without reordering.
- [ ] No remote input exceeds 32,000 characters.
- [ ] Local default clipping is applied before the hard service maximum.
- [ ] Every backend result maps to exactly one input.
- [ ] Result-count mismatch fails open.
- [ ] Negative classifications below threshold are kept.
- [ ] `confidence:null` is kept.
- [ ] Sensitive records are absent from request bodies.
- [ ] Backend error/timeout/429 does not hide candidates.
- [ ] Cache files contain no raw candidate text.
- [ ] stdout contains data only; diagnostics use stderr.
- [ ] Router success does not mask a failed build/test exit code.
- [ ] Skill text says to use the router before bulk output enters context.
- [ ] Skill text says not to use it for small visible sets.
- [ ] Skill text says classification does not prove correctness/security.
- [ ] Plugin has no default MCP dependency.
- [ ] Plugin has no mandatory hooks.
- [ ] Any future hook uses only currently documented output fields.
- [ ] Documentation distinguishes standard Codex from API-level deferred tool search.
- [ ] Linux/macOS/Windows tests pass with Node 20+.
- [ ] Network integration tests use synthetic public text only.

---

## 30. Source verification

The design was checked against the following current sources on **2026-09-19**.

### OpenAI / Codex

- Codex hooks:  
  https://developers.openai.com/docs/hooks
- Building skills / progressive disclosure:  
  https://developers.openai.com/docs/build-skills
- Plugin packaging and bundled hooks:  
  https://developers.openai.com/plugins/build/plugins
- MCP extension documentation:  
  https://developers.openai.com/docs/extend/mcp
- OpenAI Responses API reference, including deferred/BYOT tool search types:  
  https://developers.openai.com/api/reference

### classifier.dev

- Service:  
  https://classifier.dev/
- Developer/API information:  
  https://classifier.dev/developers
- OpenAPI:  
  https://classifier.dev/openapi.json
- MCP endpoint:  
  https://classifier.dev/mcp
- Source repository:  
  https://github.com/mrmps/classifier-dev
- Agent skill source:  
  https://github.com/mrmps/classifier-dev/blob/main/src/SKILL.md
- MCP implementation source:  
  https://github.com/mrmps/classifier-dev/blob/main/src/mcp.ts
- OpenAPI implementation source:  
  https://github.com/mrmps/classifier-dev/blob/main/src/openapi.ts
- Privacy implementation source:  
  https://github.com/mrmps/classifier-dev/blob/main/src/privacy.ts

### Optional future local backend research

- Hugging Face zero-shot classification documentation:  
  https://huggingface.co/docs/transformers/tasks/zero_shot_classification
- ModernBERT zero-shot model family:  
  https://huggingface.co/MoritzLaurer/ModernBERT-base-zeroshot-v2.0

---

## 31. Final implementation recommendation

Implement **Phase 1 through Phase 3 first**.

The key feature is not “Codex has a classifier tool.” The key feature is:

```text
Codex asks a local tool to search/build/query
        ↓
bulk output is piped through semantic-router
        ↓
semantic-router performs local secret checks
        ↓
eligible candidates are batch-classified for free
        ↓
only relevant + uncertain records are printed
        ↓
Codex receives a much smaller, high-recall result
        ↓
Codex reasons and verifies normally
```

This architecture produces real context savings with the current Codex interfaces, has no required paid dependency, introduces no mandatory hook trust surface, keeps classifier failures non-fatal, and leaves room for tool search, skill ranking, hooks, or a local model later without redesigning the core.
