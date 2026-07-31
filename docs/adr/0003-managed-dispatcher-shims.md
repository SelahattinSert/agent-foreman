# ADR 0003: Managed dispatcher shims

- Status: Accepted
- Date: 2026-07-31

## Context

`codex` must retain its exact normal process behavior while `codex agent-foreman` enters the orchestrator. Replacing or modifying the provider installation would create upgrade, recursion and recovery risks.

## Decision

Install a separate managed executable earlier on `PATH`. Installation resolves and records the real binary's canonical absolute path after excluding the shim directory. The dispatcher intercepts only an exact first positional `agent-foreman`; every other invocation spawns the recorded binary with the original argument array, inherited environment and terminal streams, forwards signals and returns its exit status. A dispatch-depth variable and identity checks fail closed on recursion.

Managed files and metadata are content-hashed. Installation and removal are idempotent; uninstall refuses modified files and never touches the real binary. Shell startup files are not edited automatically—the command prints explicit setup for Bash, Zsh, Fish, PowerShell or Command Prompt.

## Consequences

Normal CLI fidelity is fixture-tested and the provider remains independently upgradeable. Users must intentionally place the managed directory on `PATH`; this extra step makes the system change visible and reversible.
