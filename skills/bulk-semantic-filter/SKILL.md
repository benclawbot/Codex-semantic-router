---
name: bulk-semantic-filter
description: Filter or tag large textual candidate sets before Codex reads them. Use for 8+ search matches, log/test records, issue/PR summaries, docs snippets, changed-file summaries, or similar bulk text when only a subset is useful. Do not use for small sets already visible in context.
---

# Bulk Semantic Filter

Use the bundled router when a command or export will produce many independent text candidates and only a subset is likely to matter. The value comes from filtering **before** raw bulk output enters Codex context.

## Rules

1. Use the router automatically for at least 8 independent candidates. Never auto-classify fewer than 5; use `--force` only when the user explicitly wants classification on a small set.
2. Prefer a pipeline so the producer's raw output is consumed directly by `scripts/router.mjs`.
3. Give `filter` a concrete task goal. Do not use vague goals such as "find useful things".
4. The router is recall-first: low-confidence negatives stay visible. Treat retained items as candidates, not proof.
5. Never use classifier output to certify correctness, security, merge safety, or whether required tests may be skipped.
6. Do not intentionally send credentials, private keys, `.env` contents, authentication headers, or full confidential source files. The router also blocks probable secrets locally.
7. If classifier.dev is unavailable, rate-limited, disabled, or the local budget/circuit breaker blocks a call, continue with normal local tools. The router fails open.
8. When triaging test/build output, capture the authoritative command exit status separately and restore it after filtering. The router must not turn a failing command into a passing one.
9. For single-label tagging, include `other` or `none of these` unless the labels are truly exhaustive.
10. For a handful of visible candidates, reason directly instead of calling the router.

## Invocation

From this skill directory:

```bash
node ./scripts/router.mjs <command> [options]
```

The CLI has zero npm dependencies and requires Node.js 20+.

## Repository search filtering

```bash
rg -n --no-heading "session|delete|remove" . \
  | node ./scripts/router.mjs filter \
      --goal "Find implementation, call sites, and tests responsible for deleting or clearing saved sessions"
```

Open files from the retained output only, then broaden the search if evidence is missing.

## Test-log triage while preserving failure status

```bash
tmp="$(mktemp)"
set +e
cargo test --workspace >"$tmp" 2>&1
code=$?
set -e

grep -E 'error|fail|panic|warning|caused by|assert' "$tmp" \
  | node ./scripts/router.mjs tag \
      --labels "root-cause candidate,secondary failure,environment,warning,other" \
      --instructions "Classify diagnostics from this failed test run."

exit "$code"
```

Do not infer success from filtered output. The saved exit code remains authoritative.

## Changed-file triage

```bash
git diff --name-status main...HEAD \
  | node ./scripts/router.mjs tag \
      --labels "behavioral code,test,documentation,generated or mechanical,configuration,other"
```

Use the tags to decide review order only.

## Documentation candidates

```bash
some-doc-search-command \
  | node ./scripts/router.mjs filter \
      --goal "Find documentation explaining Codex PreToolUse hook output fields"
```

Prefer title + heading + short snippet records rather than entire pages.

## JSONL issue or PR summaries

Input:

```jsonl
{"id":"123","text":"Crash deleting recent session on Windows","url":"..."}
{"id":"124","text":"Update screenshots in README","url":"..."}
```

Filter:

```bash
node ./scripts/router.mjs filter \
  --format jsonl \
  --goal "Find issues likely related to session deletion failures on Windows" \
  < issues.jsonl
```

The full JSON object remains local; only the configured text field is eligible for remote classification.

## Useful commands

```bash
node ./scripts/router.mjs health
node ./scripts/router.mjs config
node ./scripts/router.mjs uncertain --labels "bug,feature,docs,other" --below 0.70 < items.txt
node ./scripts/router.mjs count --labels "bug,feature,docs,question,other" < items.txt
```

Use `--offline` to guarantee no remote request. Repository policy can disable remote classification with `.codex/semantic-router.json` containing `{"remote":false}`.
