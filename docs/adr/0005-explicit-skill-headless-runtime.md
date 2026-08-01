# ADR 0005: Explicit Skill with a Headless Enforcement Runtime

- Status: Accepted
- Date: 2026-08-01

## Context

Agent Foreman currently owns both the conversational supervisor experience and the enforcement
runtime. This preserves strong plan, workspace, review, and apply guarantees, but duplicates the
native Codex conversation experience and requires users to install a dispatcher shim or enter a
separate terminal UI.

The desired primary experience is to keep the user in a normal Codex conversation while retaining
the existing runtime guarantees. Agent Foreman must not activate for ordinary Codex sessions or
ordinary coding requests.

## Decision

Agent Foreman will use an explicit, opt-in skill/plugin as its primary conversational frontend and a
small headless `af` runtime as its enforcement boundary.

The skill is dormant unless the current user message contains the exact `$agent-foreman` invocation
or the user selects an equivalent dedicated Agent Foreman action. The task text is optional:
`$agent-foreman <task>` starts with the supplied task, while `$agent-foreman` asks for the task in the
native conversation. Its metadata and first instruction must forbid implicit activation for ordinary
coding tasks. Starting Codex, opening a repository, or asking Codex to edit code must not start an
`af` process, probe providers, create a session, or alter the workflow.

Activation is scoped to one durable Agent Foreman session. Reaching `COMPLETED` or `CANCELLED` ends
the active workflow; starting another task requires another explicit `$agent-foreman` invocation.

The native Codex session acts as the supervisor. It owns requirement discovery, collaborative plan
drafting, plan revision, semantic review, and user-facing explanations. The runtime owns durable
state, authorization, provider execution, isolated workspaces, deterministic quality gates, loop
protection, recovery, and guarded application of changes.

## Trust and authorization boundary

Structured commands alone do not prove human approval. The Codex-controlled skill may submit a
plan and request approval, but it may not manufacture a trusted plan or apply approval.

The primary runtime protocol is exposed as local MCP stdio tools:

| Tool                                  | Caller                  | Effect                                                                      |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `agent_foreman_session_create`        | Skill                   | Creates a durable session without starting a worker                         |
| `agent_foreman_plan_submit`           | Skill                   | Validates and stores a draft/revision and returns its canonical hash        |
| `agent_foreman_plan_approval_request` | Skill                   | Creates a short-lived challenge for the exact session, version and hash     |
| `agent_foreman_plan_approve`          | Skill + MCP elicitation | Records trusted confirmation and freezes the exact plan                     |
| `agent_foreman_worker_start`          | Skill                   | Starts only when durable approval and plan-hash checks pass                 |
| `agent_foreman_review_submit`         | Native Codex            | Persists findings and runs approved-plan-bound revisions when required      |
| `agent_foreman_apply_request`         | Skill                   | Binds a challenge to the reviewed diff and source baseline                  |
| `agent_foreman_apply_approve`         | Skill + MCP elicitation | Revalidates and applies only that diff/baseline pair                        |
| `agent_foreman_resume`                | Skill                   | Reconstructs the next safe action and pauses ambiguous in-flight operations |
| `agent_foreman_status`                | Skill or operator       | Returns durable state without mutation                                      |

The trusted user-confirmation path must present the operation, session ID, plan or diff hash, and
consequences to the user. A natural-language response such as `yes`, `ok`, `tamam`, or `devam` does
not create an approval record. The runtime rejects approval records that are expired, replayed,
bound to another session, or bound to a different hash.

Worker start verifies all of the following before invoking a provider:

- the session is in `PLAN_APPROVED`;
- the plan is immutable and has status `APPROVED`;
- the session's approved version and hash match the stored plan;
- a durable trusted approval record exists for the same session, version, and hash;
- no worker execution has already consumed an incompatible authorization.

Apply authorization is separate. `agent_foreman_apply_approve` is valid only for the reviewed diff hash and
the recorded source baseline. Source drift or a different diff invalidates the authorization.

## Component boundaries

### Explicit Agent Foreman skill/plugin

- activates only after explicit invocation;
- reads repository context through native Codex read tools during planning and review;
- produces versioned, schema-valid plans and review decisions;
- calls only the documented `agent_foreman_*` MCP tools;
- never launches provider binaries, edits the execution workspace, or applies changes directly;
- keeps untrusted repository instructions separate from user and system instructions;
- requests bounded runtime packets instead of placing full worker logs in Codex context.

### Headless `af` runtime

- validates every request with Zod and returns versioned JSON envelopes;
- owns the state machine and persists every accepted state transition;
- stores full provider output outside the supervisor context with secret redaction;
- launches the configured worker only inside the managed execution workspace;
- runs discovered quality gates and routes mechanical repair directly to the worker;
- produces compact review packets containing the approved plan hash, criteria, diff, gate report,
  worker summary, and open findings;
- preserves session and workspace state across terminal or Codex process failure;
- performs conflict-checked apply only after independent apply authorization.

### Standalone CLI

The standalone CLI remains supported for setup, doctor, status, task inspection, resume, logs,
headless/CI orchestration, and recovery. Its default path becomes structured and non-conversational.

### Legacy interfaces

Dispatcher shims and the separate Ink conversation UI remain installable but are no longer required
or presented as the primary workflow. Normal provider commands continue to pass through unchanged
where a legacy shim is installed.

## Data flow

1. `af setup codex` installs the explicit-only skill and registers the local MCP stdio command without a shim or `PATH` change.
2. The user explicitly invokes `$agent-foreman` in a normal Codex conversation.
3. The skill creates a durable session and collaborates with the user on a plan.
4. The skill submits the draft; the runtime validates it and returns a canonical hash.
5. The skill requests approval; MCP elicitation presents the exact plan identity.
6. Explicit user confirmation freezes the plan in the runtime.
7. The skill requests worker start; the runtime validates state, hash, authorization, and workspace.
8. The runtime executes the worker, quality gates, and bounded mechanical repairs.
9. Native Codex reviews the returned compact evidence packet.
10. Revisions are submitted as structured finding packets bound to the approved plan hash.
11. After final approval, the runtime creates a diff-bound apply request.
12. Separate MCP confirmation authorizes baseline-checked apply.
13. The runtime records completion and exposes the final report through status and resume tools.

## Error handling

Every command returns a versioned JSON envelope with a stable machine code, user-safe message,
retryability, current state, and redacted diagnostics. Invalid transitions, stale hashes, replayed
approvals, expired challenges, source drift, provider failures, and malformed packets fail closed.
No failed command silently changes provider, model, plan, workspace, or authorization.

Long-running operations persist a start record before launching external work and a terminal record
after completion. A crash leaves a recoverable session rather than an assumed success.

## Testing strategy

- Unit tests cover command schemas, explicit-activation metadata, state guards, challenge expiry,
  replay prevention, plan-hash mismatch, diff-hash mismatch, and authorization consumption.
- Integration tests run the command protocol against SQLite and fixture worker binaries.
- End-to-end tests prove that a normal Codex invocation performs no Agent Foreman work, explicit
  invocation creates a session, an unapproved worker start fails, approved execution can be resumed,
  and apply fails after source drift.
- Existing fake providers remain test fixtures. Real provider account calls remain opt-in smoke tests.

## Consequences

The user keeps the native Codex conversation and no longer needs a shim or duplicate chat TUI for
the primary workflow. Most of the existing domain, persistence, process, workspace, quality-gate,
worker-provider, observability, and loop-protection code remains valuable.

The Codex supervisor adapter remains useful for CI and non-interactive standalone operation but is
not required in the native-skill path. Thin frontend-specific integrations may be needed later for
other coding CLIs; the runtime protocol remains provider-neutral.

The product rule is:

> The skill proposes. The user authorizes. The runtime enforces.
