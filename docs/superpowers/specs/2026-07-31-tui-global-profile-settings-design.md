# TUI Global Profile Settings Design

- Status: Approved
- Date: 2026-07-31
- Scope: Global Agent Foreman provider profiles and first-run configuration

## Objective

Let a terminal user configure a usable global supervisor/worker profile without remembering profile commands or editing TOML. The same Ink wizard opens from `af settings` and automatically before a task when the selected profile lacks either explicit model. No provider, model, or credential fallback is permitted.

## User flow

The settings experience is a sequential Ink wizard optimized for keyboard use, narrow terminals and screen readers:

1. Select an existing global profile or create a named profile.
2. Select a runtime-supported supervisor provider.
3. Select or enter the exact supervisor model.
4. Select supervisor reasoning effort when supported.
5. Select a runtime-supported worker provider.
6. Select a discovered worker model or enter an exact model when discovery is unavailable.
7. Run provider and exact-model health checks using the unsaved candidate profile.
8. Review the profile/provider/model/binary summary.
9. Explicitly save the global profile or cancel without a write.

Arrow keys move through lists, Enter selects, Escape cancels, and typed fields support editing. A failed health check blocks saving and shows actionable diagnostics. A warning requires a second explicit confirmation. Passing checks enable the final `Save global profile` action.

## Entry points and compatibility

- `af settings` opens the wizard when stdin/stdout are TTYs.
- In non-TTY environments, `af settings` preserves the existing redacted effective-config output and performs no writes.
- `af`, `af run` and dispatcher calls such as `codex agent-foreman` invoke the wizard before provider health checks when the selected profile lacks an explicit supervisor or worker model.
- After a successful first-run save, the original task continues in the same process using freshly reloaded configuration.
- CLI profile commands and direct TOML configuration remain supported.

## Architecture

### Global profile service

A UI-independent application service loads the global document, lists profiles, builds a candidate profile and atomically saves it with `saveConfigDocument`. It owns profile-name validation, active-profile selection and merge behavior. It never reads or stores credentials.

### Provider settings catalog

The CLI composition exposes role-specific provider choices that correspond to implemented runtime adapters:

- Supervisor: `codex-cli`
- Worker: `gemini-cli`, `antigravity-cli`

Each choice carries display name and effective binary information. The catalog is outside orchestration core and can grow when another production adapter is registered.

### Candidate validation

The service resolves an in-memory candidate document with normal config precedence, constructs the real adapters and performs health checks before persistence. Worker model discovery populates a list when advertised. Codex currently has no validated model-list command, so its exact model is a required text field and is checked by the provider health/runtime boundary without fallback.

`FAIL` prevents saving. `WARN` produces a separate confirmation screen. Provider exceptions are converted to a visible failed validation result and do not modify the config file.

### Ink controller and view

A deterministic settings controller owns wizard state, field values, transitions, validation status and save eligibility. React/Ink renders that snapshot and translates input events into controller actions. Filesystem writes, provider probes and process calls enter through injected async dependencies so controller tests never touch user configuration or real accounts.

The workflow TUI remains separate. The settings wizard completes before a workflow controller or provider execution context is created.

## Data and persistence

Only the selected global profile and `active_profile` change. Existing unrelated global settings and profiles are preserved. The final document is validated with Zod and written via temporary-file plus atomic rename with user-only permissions where supported.

Provider binary settings already present under `[providers.<id>]` are retained and displayed. Secrets, authentication tokens, environment values and raw health outputs are neither added to the profile nor rendered.

Cancellation at any step returns a cancelled result without calling the save dependency. A failed atomic write leaves the original config intact and displays the typed error.

## First-run decision

First-run setup is required when either resolved role lacks a model. Missing provider binaries or authentication do not silently switch providers; they appear during validation. A complete existing profile bypasses the wizard and preserves current startup behavior.

## Testing strategy

Development follows red-green-refactor:

- Controller unit tests cover step order, list navigation, manual model input, cancellation, failed health, warning confirmation and explicit save.
- Profile-service tests use temporary global config paths to prove merge/preservation, atomic save and no write on cancellation/failure.
- CLI tests prove TTY settings routing, non-TTY read-only fallback and automatic first-run setup before the task runner.
- Provider discovery/health is represented by injected deterministic adapters in UI tests; existing adapter tests continue to cover real command construction.
- The complete monorepo build, lint, test, typecheck and format checks run before the implementation commit.

## Security and accessibility

- The wizard writes only the platform-standard global Agent Foreman config path.
- It never accepts arbitrary shell strings or executes user-entered model/provider text as a command.
- Provider choices come from the registered catalog; binary overrides continue to be validated config values.
- No secret entry field exists.
- All decisions have text labels, current-step text and error text; color is supplementary and honors `NO_COLOR`.
- Screen-reader mode remains compatible with Ink's screen-reader environment setting.

## Acceptance criteria

1. A new user can configure a global Codex supervisor and Gemini-compatible/Antigravity worker entirely in the TUI.
2. Missing models automatically trigger setup before a task.
3. Exact provider/model health validation occurs before any config write.
4. Failed validation and cancellation leave the global file unchanged.
5. Saving preserves unrelated profiles and settings and activates the chosen profile.
6. Non-TTY settings output remains redacted and read-only.
7. Existing CLI configuration workflows continue to work.
