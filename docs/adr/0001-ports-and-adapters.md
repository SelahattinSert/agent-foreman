# ADR 0001: Provider-neutral ports and adapters

- Status: Accepted
- Date: 2026-07-31

## Context

Agent Foreman must orchestrate multiple coding CLIs and raw model endpoints without binding workflow policy to any provider transport or version-specific flag.

## Decision

Keep contracts and workflow policy in provider-neutral packages. Define capability-driven supervisor and worker ports in `provider-sdk`. Place each CLI or HTTP implementation in a separate adapter package. Keep process execution, workspace mutation, persistence, quality gates, prompts, and UI behind their own boundaries.

Real command flags are adapter configuration discovered from installed help output and verified against primary documentation. Unknown capabilities are reported as false; missing models fail explicitly.

## Consequences

Core tests run entirely with fakes, adapters can evolve with provider releases, and unsupported capabilities remain visible. The trade-off is more boundary types and adapter conformance tests.
