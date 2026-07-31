# Agent Foreman

Use your smartest AI as the supervisor and your fastest AI as the worker — directly from your coding CLI.

Agent Foreman is a local, approval-gated supervisor–worker orchestrator for AI coding CLIs. Codex collaborates on a structured plan and reviews the result; a Gemini-compatible or Antigravity CLI implements it in an isolated workspace. Deterministic checks run between implementation and semantic review, and nothing is copied back without a second explicit approval.

Agent Foreman improves reliability through collaborative planning, deterministic checks, iterative review and explicit human approval. It does not guarantee defect-free output.

## Why use it?

The design reserves expensive model judgment for requirements, architecture and review while delegating implementation throughput to a faster coding agent. It also makes the two consequential boundaries—starting implementation and applying changes—visible and auditable.

```text
User ↔ Codex supervisor: discover → discuss → draft/revise → /approve
                                      │ frozen plan + SHA-256
                                      ▼
              isolated worker: implement ↔ deterministic repair
                                      │ passing gates
                                      ▼
                  Codex: semantic review ↔ worker revision
                                      │ final technical approval
                                      ▼
                   User: inspect diff → /apply → guarded apply
```

## Installation

Agent Foreman requires Node.js 22.13 or newer. From a package release:

```sh
pnpm add -g agent-foreman
af settings
af doctor
af install-shim codex
```

The installer displays the real binary and every managed file before asking. It never overwrites Codex or edits shell startup files. Add the printed managed directory to `PATH`, or print the command again with:

```sh
af shim print-shell-setup codex
```

For repository development:

```sh
pnpm install
pnpm build
node apps/cli/dist/main.js doctor
```

## Quick start

```sh
cd my-project
codex agent-foreman
```

You can also use `af` or `af run`. If the selected profile has no explicit supervisor or worker model, an interactive first run opens the global profile wizard before any session, provider call or workspace is created. The wizard lets you select the real providers, discover worker models where supported, enter exact model IDs, run health checks and explicitly save the profile.

```sh
af settings
af profile list
codex agent-foreman
```

In a non-interactive terminal, `af settings` remains read-only and prints the effective redacted configuration. Use `--plain` in a basic terminal or CI, `--output json` for JSONL events, `--no-color`/`NO_COLOR=1` without color, and `INK_SCREEN_READER=true` for Ink's screen-reader mode.

## Normal Codex usage

The shim intercepts only when the first positional argument is exactly `agent-foreman`. These calls are passed to the recorded absolute Codex binary with the same argument array, environment, terminal streams, signals and exit status:

```sh
codex
codex --help
codex exec "Fix the tests"
codex review
codex resume
codex app-server
```

`codex agent-foreman` starts Agent Foreman and records `codex` as the frontend provider. Dispatch depth, shim identity and `PATH` exclusion prevent recursion. `af uninstall-shim codex` removes only hash-verified managed files and is idempotent.

## Collaborative plan approval

The supervisor first inspects a bounded repository summary with read-only permissions, explains its understanding, asks material questions and returns a schema-validated `TaskPlan`. Use:

```text
/change <message>   create a revised plan version
/discuss <message> continue requirement discussion
/show-plan          show the Markdown plan
/show-json          show its machine form
/approve            freeze this exact version and hash
/cancel             cancel without running the worker
```

“yes”, “ok” and “tamam” are discussion text, never approval. Workspace creation, package commands and worker execution are unreachable before `/approve`. An approved plan is immutable; changes require a new version and approval.

## Provider configuration

The working runtime providers are:

- `codex-cli` supervisor through probed `codex exec --json` structured output and read-only sandboxing;
- `gemini-cli` worker through probed headless JSON mode;
- `antigravity-cli` worker through probed print/JSON/schema/edit mode.

The adapter probes installed help/version output and caches capabilities. It rejects missing structured-output flags and invalid configured models instead of inventing flags or silently choosing another model. Safe array-based `args_template` supports compatible distributions without invoking a shell. Fake providers are available only to the test suite.

`af settings` writes only the platform-standard global profile file. A failed provider check blocks saving. When a provider cannot enumerate models—currently the supported Codex Exec transport—the wizard shows a warning that requires a separate confirmation and preserves the exact model text; it never substitutes another model. Existing CLI profile commands and direct TOML configuration remain supported.

See [configuration](docs/configuration.md) and [provider development](docs/provider-development.md).
The repository also includes a copyable [balanced TOML example](examples/configs/balanced.toml).

## Security model

Repository files and provider output are untrusted data. Planning/review supervisors are read-only; workers receive a project-scoped isolated workspace; subprocesses use executable-plus-argument arrays; provider environments are allowlisted; structured outputs are validated with Zod; secrets are redacted from state, JSONL and diagnostics. Full prompts and raw model responses are not logged by default.

See [security](docs/security.md) for the threat model and limitations.

## Workspace and apply behavior

A clean Git repository gets a detached managed worktree. For a dirty repository, `/head` starts from `HEAD`, `/include` includes tracked changes after blocking sensitive paths, and `/cancel` stops. Untracked and ignored files are never copied automatically. Non-Git projects use a managed baseline snapshot that excludes `.git`, `node_modules`, Agent Foreman state, secret-like paths, symlinks and large files.

After final technical approval, `/diff` shows the patch, `/keep` preserves the workspace, `/discard` removes the managed workspace and `/apply` performs the separate approval. Apply validates the recorded branch/tree/file baseline first. Git uses `git apply --check`; snapshot apply validates every source file and rolls back completed writes if any write fails. Conflicts stop without deleting the execution workspace.

## Quality gates

When no gates are configured, Agent Foreman discovers `test`, `lint`, `typecheck`, `build` and format-check scripts from `package.json` and the lockfile-selected package manager. Explicit gates are argument arrays:

```toml
[[quality.gates]]
id = "tests"
type = "command"
command = ["pnpm", "test"]
required = true
timeout_seconds = 600
```

Gate stdout/stderr, exit status, duration and a stable failure fingerprint are persisted after redaction. Mechanical failures go directly back to the worker. Secret, scope and excessive-diff policy failures pause for the user before semantic review.

## Resume and audit

SQLite stores sessions, immutable plans/approvals, provider calls, iterations, reviews/findings, gates, workspaces, user decisions and token usage. Every state transition is transactional and mirrored to append-only redacted JSONL; startup reconciles a committed SQLite event missing from JSONL.

```sh
af task list
af task show <id>
af task logs <id>
af task diff <id>
af task resume <id>
af task cancel <id>
```

Resume restores planning, execution, repair, semantic review, final review and apply boundaries. Interrupted non-idempotent provider operations are recovered from their persisted completion record when one exists; the managed workspace is preserved on pause or failure.

## CLI reference

The implemented surface includes `af run`, `settings`, `init`, `doctor`, `version`; profile `list/create/edit/use/delete`; provider `list/doctor/models`; task `list/show/resume/cancel/logs/diff`; and shim `install-shim/uninstall-shim/status/print-shell-setup`. Run `af --help` or a command's `--help` for exact flags. Fake providers are compiled only into tests and are never selectable from the production CLI.

## Troubleshooting

Start with `af doctor`. It reports `PASS`, `WARN`, `FAIL` or `SKIP` for Node, Git, configuration/model presence, data-directory writes, SQLite, provider binaries/authentication/capabilities, worktree support, shim integrity/recursion and platform compatibility without displaying secret values. See [troubleshooting](docs/troubleshooting.md).

## Roadmap

The core daily-use path is Codex Exec as supervisor plus Gemini-compatible/Antigravity CLI as worker. Additional transports can implement the existing provider contracts: Codex App Server, Claude CLI and carefully capability-scoped OpenAI-compatible planning/review adapters. Raw models do not receive an unrestricted shell or filesystem harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Changes must include proportionate tests and pass build, lint, test, typecheck and format checks on Linux, macOS and Windows CI.

## License

Apache-2.0 was selected over MIT because its explicit patent grant and patent-termination terms give provider/plugin authors and commercial adopters clearer protection while remaining permissive. See [ADR 0002](docs/adr/0002-apache-2-license.md).
