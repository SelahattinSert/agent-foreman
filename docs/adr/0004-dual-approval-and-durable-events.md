# ADR 0004: Dual approval and durable event transitions

- Status: Accepted
- Date: 2026-07-31

## Context

Natural-language assent is ambiguous, model output is untrusted, and a crash between an external action and a state write can otherwise lose the authorization or evidence needed to resume safely.

## Decision

Use two exact human authorization boundaries. `/approve` freezes a canonical plan version, timestamp and SHA-256 before any execution workspace or worker starts. `/apply` is a separate decision after deterministic gates, semantic/final review and diff presentation. “yes”, “ok”, “tamam” and model recommendations never create either approval.

All workflow states change only through typed events committed with the session in one SQLite transaction. Provider executions, worker iterations, reviews, findings, gates, workspaces and user decisions are persisted as separate evidence. After commit, a redacted append-only JSONL record is written; startup reconciles committed events missing from JSONL. Resume inspects the last durable boundary and does not blindly repeat a completed provider operation.

## Consequences

Authorization is auditable and crash recovery can fail closed while retaining the workspace. The cost is more persisted records and explicit interaction, which is intentional for changes to source code.
