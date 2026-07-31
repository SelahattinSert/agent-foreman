# Security Model

Agent Foreman crosses trust boundaries between a user, repository, local executables, model providers, Git workspaces, and persisted logs. Default-deny permissions and explicit approvals are core workflow invariants rather than prompt-only instructions.

| Threat                                               | Primary controls                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Malicious repository instructions / prompt injection | Treat repository text as quoted untrusted data; system role constraints; read-only planning; structured schema validation          |
| Shell injection                                      | Executable plus argument arrays; no shell interpolation; local permission policy validates commands                                |
| Binary path hijacking / provider impersonation       | Resolve absolute paths, symlink chains and identity; exclude shim directory; capability/version probe; display selected binary     |
| Shim recursion                                       | Stored real path, dispatch-depth ceiling, binary identity check, and shim-directory PATH exclusion                                 |
| Symlink attacks / workspace escape                   | Canonical-path containment checks, safe roots, no implicit untracked/ignored copying, race-resistant file operations               |
| Secret or log leakage                                | Environment allowlists, pattern/field redaction, no full prompts/responses by default, debug capture is explicit                   |
| Destructive commands                                 | Deny privileged, recursive-delete, publish/push, production migration, cloud deletion, and credential access by default            |
| Untrusted or malformed provider output               | Zod validation; output never becomes a command without policy validation; bounded sizes and parse errors                           |
| Dependency supply chain                              | Lockfile, minimal maintained dependencies, review of install scripts/advisories, reproducible CI                                   |
| Apply races / dirty-worktree loss                    | Baseline branch/tree/file fingerprints, staged all-or-nothing apply where possible, stop on conflict, preserve execution workspace |
| Unsafe environment forwarding                        | Passthrough shims preserve the environment by contract; provider execution uses an explicit allowlist and redaction                |
| Arbitrary plugins                                    | No in-process marketplace loading in MVP; future plugins require declared capabilities, identity, trust, and isolation policy      |

Supervisors cannot edit files by default. Workers cannot access outside their execution workspace by default. Technical approval and apply approval remain separate user decisions.
