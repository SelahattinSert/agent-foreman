# Provider adapter example boundary

An out-of-tree provider adapter should depend on `@agent-foreman/provider-sdk` and `@agent-foreman/contracts`, implement `SupervisorProvider`, `WorkerProvider`, or both, and expose observed capabilities through `descriptor()`.

Keep transport/version flags inside the adapter. Probe the installed CLI or endpoint, use executable-plus-argument arrays, honor `ProviderExecutionContext` timeout/abort/permissions/environment, emit normalized lifecycle events and validate every response with the corresponding Zod contract before returning it.

Agent Foreman does not load arbitrary packages automatically. Integrating an adapter currently requires an explicit application composition change, so installing an untrusted package cannot silently grant local code execution.
