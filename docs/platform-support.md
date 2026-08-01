# Platform support

Agent Foreman supports Node.js 22.18+ and Node.js 24 on Linux, macOS and Windows. “Supported” means the packaged product—not only TypeScript source—must pass the platform acceptance suite.

| Platform | Native paths                                  | Dispatcher coverage                                                                                    | Runtime coverage                                                         |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Linux    | XDG config/data/state                         | POSIX shim, real passthrough and interception                                                          | Packed global CLI, SQLite, Git worktree/apply, MCP and provider fixtures |
| macOS    | `~/Library/Application Support/Agent Foreman` | POSIX shim, real passthrough and interception                                                          | Packed global CLI, SQLite, Git worktree/apply, MCP and provider fixtures |
| Windows  | `%APPDATA%` and `%LOCALAPPDATA%`              | CMD and PowerShell shims, PATHEXT discovery, `.cmd` provider launch, real passthrough and interception | Packed global CLI, SQLite, Git worktree/apply, MCP and provider fixtures |

## Release acceptance

The GitHub Actions matrix runs on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node.js 22 and 24. Every job must pass:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm verify:package
pnpm lint
pnpm test
pnpm typecheck
pnpm format:check
```

`verify:package` creates the publishable tarball, installs it under a temporary global prefix, verifies the packaged skill and executable, opens isolated SQLite state, installs a managed Codex fixture shim, checks normal passthrough data and exit codes, checks exact `agent-foreman` interception, and uninstalls the shim. It never changes the host’s real provider binaries, profiles or user directories.

The test suite additionally executes Git worktree/diff/apply, crash recovery, MCP approval, Codex structured-output and Gemini/Antigravity headless fixture flows on each runner. Windows-specific tests use native `.cmd` and PowerShell processes rather than simulating Windows quoting on Linux.

## Provider limitation

Public CI does not receive real Codex, Gemini or Antigravity credentials. Provider transport and output behavior are tested with executable fixtures; installed provider versions are probed at runtime. Before publishing a release, maintainers should run `af doctor` and one explicit end-to-end provider smoke on each platform for the provider versions advertised in the release notes. A missing capability or invalid model must fail visibly and must never trigger a silent fallback.
