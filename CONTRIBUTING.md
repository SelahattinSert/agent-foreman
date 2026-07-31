# Contributing

Use Node.js 22.13 or newer and the pnpm version declared in `package.json`.

1. Discuss material architectural or security changes before implementation.
2. Work test-first for behavior changes.
3. Keep provider-specific details out of `packages/core` and `packages/contracts`.
4. Run `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm format:check`.
5. Never use real provider credentials or user configuration in tests.

By participating, you agree to follow the Code of Conduct and license contributions under Apache-2.0.
