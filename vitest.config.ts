import {fileURLToPath} from 'node:url';

import {defineConfig} from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agent-foreman/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@agent-foreman/core': fromRoot('./packages/core/src/index.ts'),
      '@agent-foreman/observability': fromRoot('./packages/observability/src/index.ts'),
      '@agent-foreman/config': fromRoot('./packages/config/src/index.ts'),
      '@agent-foreman/persistence': fromRoot('./packages/persistence/src/index.ts'),
      '@agent-foreman/process': fromRoot('./packages/process/src/index.ts'),
      '@agent-foreman/prompts': fromRoot('./packages/prompts/src/index.ts'),
      '@agent-foreman/provider-sdk': fromRoot('./packages/provider-sdk/src/index.ts'),
      '@agent-foreman/provider-codex-cli': fromRoot('./packages/providers/codex-cli/src/index.ts'),
      '@agent-foreman/provider-gemini-cli': fromRoot(
        './packages/providers/gemini-cli/src/index.ts',
      ),
      '@agent-foreman/quality-gates': fromRoot('./packages/quality-gates/src/index.ts'),
      '@agent-foreman/runtime': fromRoot('./packages/runtime/src/index.ts'),
      '@agent-foreman/workspace': fromRoot('./packages/workspace/src/index.ts'),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    environment: 'node',
    include: [
      'apps/*/tests/**/*.test.{ts,tsx}',
      'packages/*/tests/**/*.test.ts',
      'packages/providers/*/tests/**/*.test.ts',
    ],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
