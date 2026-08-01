# Agent Foreman Implementation Plan

> Status snapshot: 2026-08-01. The primary product path is now an explicit Codex skill plus a local MCP stdio enforcement runtime. Real provider account calls remain opt-in and are never required by CI.

## Goal and boundaries

Agent Foreman is a provider-neutral, approval-gated supervisor–worker orchestrator. Native Codex owns the primary conversation only after `$agent-foreman` is explicitly invoked; the headless runtime owns durable state and mutation authorization. Core policy never imports a concrete provider, process, workspace, database or UI implementation. The original coding CLI remains untouched and the worker cannot run before an immutable plan approval.

## Package map

| Package         | Responsibility                                                   |
| --------------- | ---------------------------------------------------------------- |
| `contracts`     | Zod wire/domain schemas                                          |
| `core`          | state machine, approvals, typed errors and loop policy           |
| `config`        | TOML, platform paths, profiles and precedence                    |
| `persistence`   | SQLite migrations/repositories and JSONL audit                   |
| `process`       | safe subprocesses, discovery, signals and shims                  |
| `workspace`     | Git worktrees, snapshots, diff, guarded apply                    |
| `quality-gates` | discovery, commands and deterministic policy gates               |
| `provider-sdk`  | provider-neutral capabilities and role contracts                 |
| `providers/*`   | probed Codex and Gemini-compatible CLI adapters                  |
| `prompts`       | versioned, schema-bound prompt templates                         |
| `observability` | secret redaction and normalized logging                          |
| `runtime`       | MCP tools, trusted approvals, real execution/review coordination |
| `apps/cli`      | Commander CLI, plain/JSON interaction, Ink TUI and orchestration |

## Milestone status

### 0 — Bootstrap: complete

Strict ESM TypeScript monorepo, pnpm, tsdown, ESLint, Prettier, Vitest, Apache-2.0, CI on Ubuntu/macOS/Windows with supported Node LTS versions, documentation and ADRs.

### 1 — Core domain: complete

Task/plan/provider/worker/review/event schemas, exhaustive event-driven state machine, invalid-transition guards, immutable plan hashing, typed errors, finding lifecycle and all configured loop protections.

### 2 — Configuration and persistence: complete

TOML precedence is CLI → project → profile → global → safe defaults. SQLite migrations cover every runtime record; state/event writes are transactional; JSONL is redacted and reconciled; resume snapshots reconstruct plan hash, workspace, providers, worker iteration, findings and gates.

### 3 — Process and dispatcher: complete

Safe subprocess arrays, capture/inherit modes, timeouts, abort/signals, binary/symlink discovery, exact dispatcher interception, recursion prevention, idempotent hash-verified POSIX/PowerShell/CMD shims, uninstall and shell setup. Fixture E2E covers passthrough/interception/exit/stdin/stdout, and a manual local probe validated the built shim against installed Codex.

### 4 — Collaborative planning: complete

Repository discovery, read-only supervisor analysis, structured draft/revision, Markdown and JSON storage, explicit namespaced approval, superseded versions and worker-start hash guard. Fake providers remain deterministic test fixtures only.

### 5 — Workspace and worker: complete

Clean/dirty Git worktrees, tracked-change inclusion policy, non-Git snapshots, real diff, Gemini-compatible and Antigravity headless adapters, cancellation and safe managed-workspace discard.

### 6 — Gates and review loop: complete

Real command discovery/execution, redacted evidence, mechanical repair before supervisor calls, diff policy gates, Codex semantic/final review, stable findings, revision packets and bounded convergence protection.

### 7 — Apply and recovery: complete

Separate apply approval, source-drift detection, Git preflight, snapshot rollback, pause/preserve/discard and resume from planning through apply. Integration tests include a deliberate mid-execution crash and SQLite recovery.

### 8 — UX and operations: complete

Plain/JSON modes, accessible Ink TUI, doctor, settings, profile/provider/task/shim commands, packaging and operational documentation.

### 9 — Native Codex hybrid: implemented

An explicit-only `$agent-foreman` skill keeps planning and semantic review in native Codex. `af setup codex` installs the managed skill and registers `af mcp serve` without a shim or `PATH` edit. MCP elicitation independently confirms plan/apply challenges. The runtime binds real worker execution, isolated workspaces, discovered quality gates, finding-preserving revisions, loop protection, guarded apply and resume packets to durable session/hash checks. Standalone CLI, Ink and shims remain secondary interfaces.

## Release verification

Run from a clean dependency graph:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:package
pnpm lint
pnpm test
pnpm typecheck
pnpm format:check
```

Provider tests use fixture executables and never touch a user's account. `pnpm verify:package` installs the publishable tarball into a temporary global prefix and exercises the packaged CLI, SQLite and native dispatcher lifecycle on every CI platform. Release smoke testing additionally probes installed binaries with `af provider doctor`, validates the exact worker model, installs the skill/MCP integration in a temporary Codex home, confirms implicit invocation is disabled, and exercises the explicit protocol through apply.

## Non-negotiable invariants

- No worker/package command/workspace mutation before exact plan approval.
- No apply without separate user approval and unchanged source baseline.
- No model fallback, shell interpolation, raw provider-output execution or plaintext secrets.
- No original-binary overwrite/delete, recursive dispatch, automatic commit/push or history rewrite.
- Required gate, must criterion, critical/high finding, significant scope change or security risk prevents approval.
