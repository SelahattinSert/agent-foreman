# Configuration

Agent Foreman loads versioned TOML in this precedence order:

```text
CLI flags → project config → selected profile → global config → safe defaults
```

The global file is `$XDG_CONFIG_HOME/agent-foreman/config.toml` (normally `~/.config/agent-foreman/config.toml`) on Linux, `~/Library/Application Support/Agent Foreman/config.toml` on macOS, and `%APPDATA%\Agent Foreman\config.toml` on Windows. Project settings live in `<project>/.agent-foreman/config.toml`. Writes are atomic and user-only where the platform supports modes.

## Global profile wizard

Run the terminal settings UI instead of editing TOML or remembering profile flags:

```sh
af settings
af profile list
af setup codex
# restart Codex, then invoke $agent-foreman
```

`af settings` opens the global profile wizard only in an interactive terminal. It writes nothing until both configured providers have been checked and you choose **Save global profile**. A failed check blocks saving; a warning requires a separate confirmation. In pipes and CI, the same command prints the redacted effective configuration and never writes a file.

The wizard selects or creates a named global profile, identifies the current Codex conversation as the native supervisor, and asks only for the worker provider and exact worker model. It discovers worker models when the installed adapter advertises that capability and displays worker health before review. Existing standalone supervisor settings are preserved; configure them through the profile commands when the secondary standalone workflow is needed. The wizard has no secret input fields. Arrow keys select, Enter continues, Backspace edits text, and Escape cancels without writing. `NO_COLOR=1` and `INK_SCREEN_READER=true` remain supported.

The saved global profile is selected by the MCP runtime for the current project. Project configuration is never silently rewritten; normal precedence remains CLI flags → project config → selected global profile → global config → safe defaults.

## Working example

```toml
version = 1
active_profile = "balanced"

[general]
ui_language = "auto"
telemetry = false
log_level = "info"

[workspace]
mode = "smart"
preserve_on_failure = true
preserve_on_pause = true

[planning]
require_explicit_approval = true
allow_repository_read = true
allow_baseline_checks = true
network_access = false

[workflow]
max_worker_iterations = 8
max_mechanical_repairs = 3
max_supervisor_reviews = 5
max_same_finding_occurrences = 2
pause_on_no_progress_iterations = 2
detect_diff_oscillation = true

[profiles.balanced.supervisor]
provider = "codex-cli"
model = "your-supervisor-model"
reasoning_effort = "high"

[profiles.balanced.worker]
provider = "antigravity-cli"
model = "your-worker-model"
session_mode = "auto"

[providers.codex-cli]
binary = "codex"
ignore_user_config = true

[providers.antigravity-cli]
binary = "agy"
sandbox = false

[quality]
require_supervisor_approval = true
maximum_open_critical = 0
maximum_open_high = 0
allow_open_medium = true
allow_open_low = true

[[quality.gates]]
id = "tests"
type = "command"
command = ["pnpm", "test"]
required = true
timeout_seconds = 600
```

For Antigravity CLI, omitted `sandbox` currently defaults to `false`, which means **worktree file-tools-only mode**: Agent Foreman creates an isolated provider home, binds a fresh Antigravity project to the execution worktree, disables slash expansion, denies every terminal command, URL action and MCP tool, and leaves build/test/lint/typecheck execution to Agent Foreman's deterministic quality gates. This is the safe portable mode for Antigravity CLI 1.1.9.

Set `sandbox = true` only when `agy --sandbox` is known to start successfully on the host. That mode enables Antigravity's terminal sandbox while preserving the isolated provider settings. Agent Foreman never falls back from a failed sandbox to unsandboxed terminal execution.

`smart` selects a Git worktree or a non-Git snapshot. `worktree` requires Git and `snapshot` forces a managed copy even for Git projects. The schema recognizes `current` for configuration compatibility, but the runtime rejects it: allowing the worker to edit the source directory before `/apply` would violate the separate apply-approval invariant.

Use `gemini-cli` with `binary = "gemini"` when the installed Gemini distribution exposes the probed headless JSON capabilities. A compatible distribution may supply `args_template` as a TOML array, never a shell string:

```toml
[providers.antigravity-cli]
binary = "agy"
args_template = ["--print", "{prompt}", "--output-format", "json", "--json-schema", "{schema}", "--model", "{model}", "--mode", "accept-edits"]
```

Supported placeholders are adapter-defined and validated; unknown placeholders fail. Each item remains a single subprocess argument, so prompt/model content cannot introduce shell syntax.

## Profiles and models

Models are explicit provider identifiers. The built-in `balanced` profile selects `codex-cli` and `gemini-cli` but intentionally contains no model names. Create a usable profile with both exact models:

```sh
af profile create balanced \
  --supervisor codex-cli --supervisor-model your-supervisor-model \
  --worker antigravity-cli --worker-model your-worker-model
af profile use balanced
af provider doctor
af provider models worker
```

Worker model discovery is used only when the installed CLI advertises it. Codex Exec does not expose a validated model-list command in the supported transport, so the wizard requires an exact manual value and reports a warning that needs separate confirmation. The entered value is preserved for provider runtime validation and is never silently replaced.

## Gates

Without `quality.gates`, package scripts are discovered from `package.json` in this order: test, lint, typecheck, build and format check. Lockfiles choose pnpm, Yarn, Bun or npm. Explicit command gates must be arrays and run with the workspace as `cwd`, timeouts, cancellation, captured stdout/stderr and redaction.

## Secrets

Do not put API keys, cookies, authorization headers or private-key material in TOML. Use an authenticated provider CLI, environment variables, an OS keychain used by that CLI, or temporary runtime input. Provider processes receive an environment allowlist; diagnostics and persisted records pass through secret redaction. `af settings` and `af doctor` never intentionally print secret values.
