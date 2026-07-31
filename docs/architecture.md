# Architecture

Agent Foreman is a ports-and-adapters system around a provider-neutral orchestration core. The core describes what may happen; adapters decide how model CLIs, databases, Git, subprocesses, and terminal UIs perform it.

```text
CLI / plain UI / Ink TUI / provider shims
                  |
          application orchestration
        /         |          \
provider SDK   core policy   persistence ports
    |             |              |
CLI/HTTP       contracts      SQLite + JSONL
adapters           |
              workspace + quality ports
                    |
              Git/process adapters
```

## Trust boundaries

- User input, repository content, provider output, executable discovery, and persisted state are untrusted at their boundaries.
- Zod validates structured data before it enters core policy.
- Only explicit UI actions or exact slash commands create plan/apply approvals.
- Planning and review supervisors receive read-only permission profiles.
- Workers receive only a frozen approved plan and an isolated workspace path.
- Provider output is descriptive data; it is never executed as a command without local policy validation.

## State and durability

The state machine is deterministic and exhaustive. An application service handles an event inside a SQLite transaction, writes the new session state and normalized workflow event, commits, then appends the redacted audit event to JSONL. Recovery reconciles committed database events that are missing from JSONL after a crash. Provider calls persist start/completion records independently so a failure never erases resumable state.

## Approval boundaries

Plan approval freezes a canonical JSON representation, its version, approval time, and SHA-256 hash. Any subsequent change creates a new plan version. Worker startup validates the approved status, approved version, and hash. Technical approval does not imply apply approval: current-workspace baseline validation and a second explicit user action are required.

## Process and shims

A shim owns only a new executable earlier on `PATH`; it never overwrites the provider binary. It records the resolved absolute real binary, excludes its own directory during discovery, checks identity and dispatch depth, and intercepts only when the first positional argument equals `agent-foreman`. All other invocations use executable-plus-argument arrays and inherited terminal streams.

## Review loop

Deterministic quality gates run immediately after worker execution. Mechanical failures return directly to the worker until a bounded repair limit. Semantic review begins only after required gates pass, except for critical security/scope conflicts, plan conflicts, or user-decision blockers. Stable finding IDs, diff hashes, failure fingerprints, budgets, and progress counters pause non-converging loops while retaining the workspace.
