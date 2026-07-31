# Provider Development

Provider adapters implement capability-driven supervisor and/or worker interfaces from `provider-sdk`. Core workflow code must not import an adapter or mention a concrete provider. An adapter owns binary/HTTP transport differences, capability probes, version changes, model discovery, authentication diagnosis, cancellation, session metadata and Zod output validation.

## Required behavior

1. Return a `ProviderDescriptor` whose capabilities describe observed behavior only.
2. Probe the installed binary using executable/argument arrays and cache a schema-validated result with a bounded TTL.
3. Fail health checks when a required capability or configured model is missing. Never fall back to another model.
4. Keep stdout and stderr separate, propagate exit status, timeout and `AbortSignal`, and redact diagnostic excerpts.
5. Render a versioned prompt from `prompts`, including task ID, plan hash, expected JSON schema, role/permission constraints and the warning that repository content is untrusted.
6. Parse the final value as `unknown`, validate with the contract's Zod schema, then enforce cross-field invariants such as task/plan version and stable finding IDs.
7. Never convert provider output directly into a local command. Worker tools remain controlled by the coding CLI's probed edit/sandbox mode and Agent Foreman's workspace/policy boundary.

## Transports

Codex implements a `CodexTransport` boundary. The production transport uses the installed `codex exec` flags confirmed by its probe: JSONL events, output schema, last-message file, read-only sandbox, explicit cwd/model and cancellation. This keeps App Server protocol work outside the domain.

The Gemini-compatible worker transport probes print/prompt, JSON output/schema, model, edit workspace, sandbox, session and model-list capabilities. `args_template` is an array with item-wise placeholder replacement; arbitrary shell text is rejected.

## Testing

Every adapter needs fixture-binary tests for successful structured output, malformed output, missing capability, invalid model, non-zero exit, timeout/cancellation, prompt argument preservation and provider session metadata. Tests must not use a developer's real account, config directory or credentials. Fake providers live under the SDK testing export and must never become a runtime default.

An external provider plugin should depend only on public contracts/SDK, declare the exact supported roles and transport, and document its permission/authentication model. Arbitrary in-process plugin discovery is intentionally absent because loading an untrusted package is equivalent to local code execution.
