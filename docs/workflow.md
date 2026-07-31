# Workflow

The runtime is an event-driven state machine. Invalid transitions throw a typed error and are not persisted.

```text
CREATED → repository discovery → requirement discussion → draft/revise
        → AWAITING_PLAN_REVIEW ── exact /approve ──→ frozen plan
        → managed workspace → worker → deterministic gates
              failed mechanical gate ──→ worker repair ──┐
              passed gates ──→ Codex review             │
                  REVISE ──→ worker revision ────────────┘
                  APPROVED ──→ final Codex review
        → TECHNICALLY_APPROVED → diff/apply decision
        → exact /apply → guarded apply → COMPLETED
```

## Planning

Repository discovery produces a bounded summary rather than uploading the whole tree. The supervisor gets read-only filesystem and read-only shell permissions, no network and no worker-launch right. Its requirement result and every plan revision are schema-validated. Plans are stored both as JSON and user-facing Markdown. `/approve` canonicalizes the approved object, records its version/time/hash and makes that version immutable.

## Execution and gates

Only the frozen plan, project summary, workspace path, constraints, baseline evidence and output schema enter the initial worker packet. Work occurs in a detached Git worktree or non-Git snapshot. The resulting diff is the source of truth; worker-reported changed files are evidence, not authority.

Discovered/configured commands run sequentially in that workspace. Required test/lint/typecheck/build/format failures create compact repair packets and do not spend a supervisor call. Secret/scope/diff policy failures, plan conflicts and user-decision blockers pause or return control to the user.

## Review and convergence

Semantic review receives the approved plan/hash, acceptance criteria, latest worker summary, diff, gates and open findings. Findings keep IDs across iterations. Approval is blocked by critical/high findings, failed must criteria/gates, important out-of-plan changes, security risks or missing required tests. Final review is a separate provider operation.

The loop tracks worker/review/repair budgets, finding recurrence, identical provider responses, repeated gate fingerprints, diff hashes, A/B/A oscillation and no-progress iterations. A trigger emits `TASK_PAUSED` and preserves the workspace for `resume`, plan change, provider switch through configuration, or cancellation.

## Apply and recovery

`/apply`, `/keep` and `/discard` are exact commands. Apply verifies the source state captured before execution and preflights the complete patch. A conflict produces no partial Git apply; snapshot apply restores completed writes from a managed backup if a later write fails. Technical approval never implies apply approval.

SQLite is authoritative. State/event writes share a transaction and JSONL is an append-only audit mirror. `af task resume <id>` reconstructs the last durable phase and continues planning, execution, gates, repair, review, final review or apply. Pause/cancel does not silently remove the workspace.
