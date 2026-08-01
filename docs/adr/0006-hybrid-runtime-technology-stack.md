# ADR 0006: Technology Stack for the Native-Codex Hybrid

- Status: Accepted
- Date: 2026-08-01

## Context

Agent Foreman's primary frontend changed from a separate Ink conversation and provider shim to an
explicit Codex skill backed by a local headless enforcement runtime. The stack must still provide
portable subprocess control, durable local state, schema validation, Git isolation and a small
structured integration surface without requiring a resident daemon.

## Decision

- Keep Node.js 22.18+, strict ESM TypeScript and pnpm workspaces. The existing process, filesystem,
  provider and cross-platform code remains a strong fit for a local terminal runtime.
- Use the stable `@modelcontextprotocol/sdk` v1 stdio server as the primary Codex integration. A
  local stdio child process has a smaller trust and lifecycle surface than an HTTP daemon.
- Keep Zod contracts at every model/MCP/persistence boundary.
- Keep SQLite as authoritative state and redacted JSONL as the append-only audit mirror. Configuration
  remains TOML; secrets remain outside TOML.
- Keep Git worktrees/snapshots and executable-plus-argument subprocesses as runtime adapters.
- Keep Ink, Commander and the dispatcher packages as secondary operational/compatibility interfaces;
  they are no longer on the primary conversational path.
- Use `tsdown` for ESM application and package builds. `tsup` was removed because its maintenance
  state no longer matched the desired production toolchain.

## Consequences

The pivot does not require a language rewrite or a daemon architecture. Most of the existing core,
persistence, workspace, quality and provider code remains reusable. The normal Codex conversation
spends supervisor tokens directly instead of spawning a second Codex process, while the runtime can
still enforce state and authorization independently of skill behavior.

The published package needs Node.js but does not require users to install pnpm. pnpm is used only to
develop and build the monorepo. Native SQLite bindings remain external in the bundled CLI and must
be covered by the Node/platform release matrix.
