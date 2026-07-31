# Troubleshooting

Run `af doctor` first. It reports `PASS`, `WARN`, `FAIL` and `SKIP` with a remediation line and never needs a real model call to print a secret.

## `MODEL NOT SET`

Agent Foreman never guesses. Create/edit a profile with both values, or pass `--supervisor-model` and `--worker-model` to `af run`:

```sh
af profile edit balanced --supervisor-model exact-codex-model --worker-model exact-worker-model
af provider doctor
af provider models worker
```

Codex Exec lacks a supported model-list command; a bad exact model is reported by the provider call. Gemini-compatible workers with a `models` capability validate the exact configured ID.

## Provider binary or capability failure

Run the same binary's `--version`/`--help`, then `af provider doctor`. Configure an alternate executable with `[providers.<id>] binary = "..."`. Agent Foreman requires the actually probed non-interactive structured-output and edit capabilities. It does not invent a flag based on another distribution's documentation.

Probe results are cached under the Agent Foreman data directory for one day. Remove only the provider probe JSON from its `cache` directory when intentionally testing an upgraded CLI; the next health check recreates it.

## `codex` recurses or does not intercept

```sh
af shim status codex
af shim print-shell-setup codex
command -v -a codex          # Bash/Zsh
Get-Command codex -All       # PowerShell
```

The managed shim directory must precede the real binary. Do not point shim metadata back to its own directory. `AGENT_FOREMAN_DISPATCH_DEPTH` greater than one fails closed. Reinstall only after inspecting the displayed real path. Uninstall refuses files whose hashes no longer match.

## Normal Codex behavior changed

Check `af shim status codex` and compare the recorded real path with the provider installation. The dispatcher only intercepts an exact first `agent-foreman`; near matches should pass through. `af uninstall-shim codex` removes the managed wrapper without altering Codex. If the wrapper was manually modified, move/inspect it yourself because Agent Foreman will not delete it.

## Dirty repository or missing files

`/head` intentionally excludes all local changes. `/include` carries tracked diffs only and blocks sensitive paths; untracked/ignored files are listed but not copied. Commit/stage a non-secret fixture or copy it manually only after understanding the risk. Non-Git snapshot mode excludes `.git`, `node_modules`, `.agent-foreman`, secrets, symlinks and files over 5 MiB.

## Quality command is missing dependencies

The isolated workspace does not share a mutable `node_modules` directory with the source. The approved worker may install project dependencies inside its workspace when the plan and configured network policy allow it. For offline/reproducible use, pre-populate the package-manager cache and use a configured gate command appropriate for the repository. Do not symlink the source `node_modules` into an untrusted worker workspace.

## Apply conflict

Agent Foreman stops if the source branch, Git fingerprint or snapshot files changed after workspace creation, or if `git apply --check` fails. It does not merge automatically. Inspect `af task diff <id>`, preserve the workspace, reconcile source changes, then resume. Snapshot write failures roll back completed writes and retain backup diagnostics.

## Interrupted task

```sh
af task list
af task show <id>
af task logs <id>
af task resume <id>
```

If a provider process was interrupted before a completion record, resume starts the safe phase again with the frozen plan/diff evidence. Completed provider records and session IDs are reused when supported. The worktree/snapshot remains on pause and cancel unless you explicitly choose discard at the apply boundary.

## JSON output

`af run --plain --output json` writes one JSON object per stdout line; interactive prompts use stderr so stdout remains machine-readable. Default logs redact likely secrets and omit full prompts/model responses.
