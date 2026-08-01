# Architecture

Agent Foreman is a ports-and-adapters system around a provider-neutral orchestration core. Native Codex is the primary conversational supervisor; an explicitly invoked skill talks to a small MCP stdio runtime that owns every durable or mutating decision.

```text
normal Codex conversation
          │ explicit $agent-foreman only
          ▼
Agent Foreman skill ── MCP stdio ── headless af runtime
                                      │
                       contracts + state machine + approvals
                         /             |               \
                  SQLite/JSONL    worker provider    workspace/gates
                                      │               │
                               Gemini/Antigravity   Git + subprocess

Standalone CLI / Ink / optional shims ── secondary adapters to the same core
```

## Trust boundaries

- User input, repository content, provider output, executable discovery, and persisted state are untrusted at their boundaries.
- Zod validates structured data before it enters core policy.
- The skill metadata forbids implicit invocation; ordinary Codex tasks never start the runtime.
- Only MCP client elicitation or another trusted user-confirmation adapter creates plan/apply approvals. Tool arguments and natural-language assent are insufficient.
- Planning and review supervisors receive read-only permission profiles.
- Workers receive only a frozen approved plan and an isolated workspace path.
- Provider output is descriptive data; it is never executed as a command without local policy validation.

## State and durability

The state machine is deterministic and exhaustive. An application service handles an event inside a SQLite transaction, writes the new session state and normalized workflow event, commits, then appends the redacted audit event to JSONL. Recovery reconciles committed database events that are missing from JSONL after a crash. Provider calls persist start/completion records independently so a failure never erases resumable state.

## Approval boundaries

Plan approval freezes a canonical JSON representation, its version, approval time, and SHA-256 hash. Any subsequent change creates a new plan version. Worker startup validates the approved status, approved version, and hash. Technical approval does not imply apply approval: current-workspace baseline validation and a second explicit user action are required.

## Process and optional shims

`af setup codex` installs a managed explicit-only skill and registers `af mcp serve` through Codex's real `mcp` command. It does not replace a binary or change `PATH`. The older generic shim remains optional: when installed it owns only a new executable earlier on `PATH`, never overwrites the provider binary, and passes ordinary invocations through with the original argument array, streams, signals and exit status.

## Review loop

Deterministic quality gates run immediately after worker execution. Mechanical failures return directly to the worker until a bounded repair limit. Semantic review begins only after required gates pass, except for critical security/scope conflicts, plan conflicts, or user-decision blockers. Stable finding IDs, diff hashes, failure fingerprints, budgets, and progress counters pause non-converging loops while retaining the workspace.
