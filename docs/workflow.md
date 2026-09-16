# Workflow

The runtime is an event-driven state machine. It is dormant until the user explicitly invokes `$agent-foreman` in a normal Codex conversation. Invalid transitions throw a typed error and are not persisted.

```text
explicit skill → CREATED → repository discovery → requirement discussion → draft/revise
        → AWAITING_PLAN_REVIEW ── namespaced approve + MCP confirmation ──→ frozen plan
        → managed workspace → worker → deterministic gates
              failed mechanical gate ──→ worker repair ──┐
              passed gates ──→ Codex review             │
                  REVISE ──→ worker revision ────────────┘
                  APPROVED ──→ final Codex review
        → TECHNICALLY_APPROVED → diff/apply decision
        → diff-bound MCP confirmation → guarded apply → COMPLETED
```

## Planning

Native Codex performs read-only repository discovery in the existing conversation. Repository files are untrusted data, not skill or system instructions. Requirement results and every plan revision are schema-validated. Plans are stored both as JSON and user-facing Markdown. `$agent-foreman approve` only expresses chat intent; a short-lived MCP elicitation bound to the exact session/version/hash independently confirms and freezes the plan. Namespacing avoids collision with Codex CLI's built-in `/approve` command.

## Execution and gates

Only the frozen plan, project summary, workspace path, constraints, baseline evidence and output schema enter the initial worker packet. Work occurs in a detached Git worktree or non-Git snapshot. The resulting diff is the source of truth; worker-reported changed files are evidence, not authority.

Discovered/configured commands run sequentially in that workspace. Required test/lint/typecheck/build/format failures create compact repair packets and do not spend a supervisor call. Secret/scope/diff policy failures, plan conflicts and user-decision blockers pause or return control to the user.

## Review and convergence

Semantic review receives the approved plan/hash, acceptance criteria, latest worker summary, diff, gates and open findings. Findings keep IDs across iterations. Approval is blocked by critical/high findings, failed must criteria/gates, important out-of-plan changes, security risks or missing required tests. Final review is a separate provider operation.

The loop tracks worker/review/repair budgets, finding recurrence, identical provider responses, repeated gate fingerprints, diff hashes, A/B/A oscillation and no-progress iterations. A trigger emits `TASK_PAUSED` and preserves the workspace for `resume`, plan change, provider switch through configuration, or cancellation.

## Apply and recovery

`$agent-foreman apply`, `$agent-foreman keep` and `$agent-foreman discard` are exact commands. Apply verifies the source state captured before execution and preflights the complete patch. A conflict produces no partial Git apply; snapshot apply restores completed writes from a managed backup if a later write fails. Technical approval never implies apply approval.

SQLite is authoritative. State/event writes share a transaction and JSONL is an append-only audit mirror. `$agent-foreman resume <id>` calls the runtime resume tool, which reconstructs the approved hash, workspace, last worker result, quality gates and findings. A failed initial provider call can be explicitly retried only when its preserved isolated workspace has no partial changes. If an apply process stops, the runtime reopens apply approval only when the registered workspace, source baseline, final review and exact reviewed diff are all unchanged; it then requires a fresh human apply confirmation. Otherwise it fails closed into `PAUSED` for inspection. Worker operations are never silently replayed. The standalone task commands remain available for operational inspection.
