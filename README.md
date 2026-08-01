# Agent Foreman

Use your smartest AI as the supervisor and your fastest AI as the worker — directly from your coding CLI.

Agent Foreman is a local, approval-gated supervisor–worker orchestrator for AI coding CLIs. You stay in the normal Codex conversation: Codex collaborates on a structured plan and reviews the result, while a Gemini-compatible or Antigravity CLI implements it in an isolated workspace. A small headless runtime enforces plan hashes, deterministic checks, durable resume and a separate apply approval.

Agent Foreman improves reliability through collaborative planning, deterministic checks, iterative review and explicit human approval. It does not guarantee defect-free output.

## Why use it?

The design reserves expensive model judgment for requirements, architecture and review while delegating implementation throughput to a faster coding agent. It also makes the two consequential boundaries—starting implementation and applying changes—visible and auditable.

```text
User ↔ Codex supervisor: discover → discuss → draft/revise → explicit approve
                                      │ frozen plan + SHA-256
                                      ▼
              isolated worker: implement ↔ deterministic repair
                                      │ passing gates
                                      ▼
                  Codex: semantic review ↔ worker revision
                                      │ final technical approval
                                      ▼
                   User: inspect diff → explicit apply → guarded apply
```

## Installation

Agent Foreman requires Node.js 22.18 or newer. From a package release:

```sh
npm install -g agent-foreman
af settings
af doctor
af setup codex
```

`af setup codex` shows the exact changes, installs an explicitly invoked local skill, and registers the headless runtime as a Codex MCP stdio server through Codex's own `mcp` command. It does not replace the Codex binary, install a shim, or edit `PATH`. Restart Codex after setup.

To remove only the hash-verified managed integration, run `af setup codex --remove`; modified or user-owned skill/MCP entries are refused.

For repository development:

```sh
npx pnpm@11.18.0 install
npx pnpm@11.18.0 build
node apps/cli/dist/main.js doctor
```

pnpm is a contributor/build dependency, not a requirement for using the published CLI.

## Platform support

Agent Foreman targets Linux, macOS and Windows with Node.js 22.18+ or Node.js 24. The release matrix builds and tests all six OS/Node combinations. It also installs the packed tarball into a temporary global prefix and exercises `af`, SQLite state, managed shim installation, normal provider passthrough, exact `agent-foreman` interception, exit-code/stdin/argument preservation and uninstall. Windows runs native CMD and PowerShell shim tests; macOS runs the POSIX shim and Application Support path tests.

Real provider authentication is intentionally absent from public CI. A release is cross-platform verified only after the full matrix is green; provider-version compatibility remains visible through `af doctor` and the adapter capability probes. See [platform support](docs/platform-support.md) for the exact evidence and limitations.

## Quick start

```sh
cd my-project
codex
```

Then explicitly invoke the skill in the normal Codex conversation:

```text
$agent-foreman Add a subtract(a, b) function and cover negative numbers.
```

Agent Foreman is dormant in every ordinary Codex message. Starting Codex, opening a repository, or asking for a normal code change does not create a session, probe the worker, or run the runtime.

If the selected global profile has no explicit worker model, run `af settings`. The wizard lets you select the real worker provider, discover models where supported, enter an exact model ID, run health checks and explicitly save the profile.

```sh
af settings
af profile list
af setup codex
```

In a non-interactive terminal, `af settings` remains read-only and prints the effective redacted configuration. The standalone `af run` plain/JSON and Ink interfaces remain available for operations and automation, but they are not required for the primary Codex experience.

## Normal Codex usage

The primary integration does not intercept the `codex` executable. All normal commands remain native Codex commands:

```sh
codex
codex --help
codex exec "Fix the tests"
codex review
codex resume
codex app-server
```

Agent Foreman runs only after an explicit `$agent-foreman` invocation. The generic dispatcher and hash-verified shims remain optional compatibility tools; they are not installed by `af setup codex`.

## Collaborative plan approval

Native Codex first inspects the repository read-only, explains its understanding, asks material questions and returns a schema-validated `TaskPlan`. Use:

```text
$agent-foreman change <message>  create a revised plan version
$agent-foreman discuss <message> continue requirement discussion
$agent-foreman show-plan         show the Markdown plan
$agent-foreman show-json         show its machine form
$agent-foreman approve           freeze this exact version and hash
$agent-foreman cancel            cancel without running the worker
```

The commands are namespaced because `/approve` is a built-in Codex CLI command for retrying automatic-review denials. “yes”, “ok” and “tamam” are discussion text, never approval. After `$agent-foreman approve`, the runtime presents an independent confirmation bound to the exact plan hash. Workspace creation, package commands and worker execution are unreachable before that confirmation. An approved plan is immutable; changes require a new version and approval.

## Provider configuration

In the primary skill path, the current native Codex conversation is the supervisor; Agent Foreman does not launch a second Codex process. The working runtime worker providers are:

- `gemini-cli` worker through probed headless JSON mode;
- `antigravity-cli` worker through probed print/JSON/schema/edit mode.

Antigravity runs in worktree file-tools-only mode by default: Agent Foreman gives it an isolated provider home and project, denies terminal/network/MCP actions, and runs deterministic quality commands itself. Hosts with a verified working Antigravity terminal sandbox may opt in with `sandbox = true`; sandbox failure never falls back to unsandboxed execution.

The standalone CLI also retains the probed `codex-cli` supervisor adapter for non-interactive operation. Adapters reject missing structured-output flags and invalid configured models instead of inventing flags or silently choosing another model. Safe array-based `args_template` supports compatible distributions without invoking a shell. Fake providers are available only to the test suite.

`af settings` writes only the platform-standard global profile file. A failed worker check blocks saving. Existing CLI profile commands and direct TOML configuration remain supported.

See [configuration](docs/configuration.md) and [provider development](docs/provider-development.md).
The repository also includes a copyable [balanced TOML example](examples/configs/balanced.toml).

## Security model

Repository files and provider output are untrusted data. Planning/review supervisors are read-only; workers receive a project-scoped isolated workspace; subprocesses use executable-plus-argument arrays; provider environments are allowlisted; structured outputs are validated with Zod; secrets are redacted from state, JSONL and diagnostics. Full prompts and raw model responses are not logged by default.

See [security](docs/security.md) for the threat model and limitations.

## Workspace and apply behavior

A clean Git repository gets a detached managed worktree. For a dirty repository, `$agent-foreman head-worktree` starts from `HEAD`, `$agent-foreman include-tracked` includes tracked changes after blocking sensitive paths, and `$agent-foreman cancel` stops. Untracked and ignored files are never copied automatically. Non-Git projects use a managed baseline snapshot that excludes `.git`, `node_modules`, Agent Foreman state, secret-like paths, symlinks and large files.

After final technical approval, `$agent-foreman diff` shows the patch, `$agent-foreman keep` preserves the workspace, `$agent-foreman discard` removes the managed workspace and `$agent-foreman apply` performs the separate approval. Apply validates the recorded branch/tree/file baseline first. Git uses `git apply --check`; snapshot apply validates every source file and rolls back completed writes if any write fails. Conflicts stop without deleting the execution workspace.

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

Use `$agent-foreman resume <id>` in Codex to reconstruct the safe next action, or inspect it operationally with `af task show <id>`. Resume reloads the approved plan/hash, workspace, last worker evidence, quality gates and open findings. A failed initial provider call may be explicitly retried only when its isolated workspace is unchanged. Stable planning/review/apply boundaries continue directly. If the runtime stopped during another potentially non-idempotent worker or apply operation, it pauses and preserves the workspace instead of silently replaying it.

## CLI reference

The primary setup command is `af setup codex`; `af mcp serve` is the registered headless transport. The operational surface also includes `af run`, `settings`, `init`, `doctor`, `version`; profile `list/create/edit/use/delete`; provider `list/doctor/models`; task `list/show/resume/cancel/logs/diff`; and optional shim `install-shim/uninstall-shim/status/print-shell-setup`. Run `af --help` or a command's `--help` for exact flags. Fake providers are compiled only into tests and are never selectable from the production CLI.

## Troubleshooting

Start with `af doctor`. It reports `PASS`, `WARN`, `FAIL` or `SKIP` for Node, Git, configuration/model presence, data-directory writes, SQLite, provider binaries/authentication/capabilities, worktree support, shim integrity/recursion and platform compatibility without displaying secret values. See [troubleshooting](docs/troubleshooting.md).

## Roadmap

The core daily-use path is native Codex as supervisor plus the headless runtime and a Gemini-compatible/Antigravity CLI worker. Additional frontends and transports can implement the same provider-neutral contracts. Raw models do not receive an unrestricted shell or filesystem harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Changes must include proportionate tests and pass build, lint, test, typecheck and format checks on Linux, macOS and Windows CI.

## License

Apache-2.0 was selected over MIT because its explicit patent grant and patent-termination terms give provider/plugin authors and commercial adopters clearer protection while remaining permissive. See [ADR 0002](docs/adr/0002-apache-2-license.md).
