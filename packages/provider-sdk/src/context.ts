import {z} from 'zod';

import type {ExecutionWorkspaceSchema} from '@agent-foreman/contracts';

export const ProviderPermissionsSchema = z.strictObject({
  filesystem: z.enum(['none', 'read-only', 'workspace-write']),
  shell: z.enum(['denied', 'read-only-allowlist', 'project-scoped']),
  network: z.enum(['denied', 'ask', 'allowed']),
  workerLaunch: z.enum(['denied', 'allowed']),
});

export type ProviderPermissions = z.infer<typeof ProviderPermissionsSchema>;

export type ProviderLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface RedactedLogger {
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  trace(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface ProviderRuntimeEvent {
  readonly type: string;
  readonly timestamp: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderExecutionContext {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly executionWorkspace?: z.infer<typeof ExecutionWorkspaceSchema>;
  readonly timeoutMs: number;
  readonly abortSignal: AbortSignal;
  readonly permissions: ProviderPermissions;
  readonly environmentAllowlist: readonly string[];
  readonly logger: RedactedLogger;
  readonly emit: (event: ProviderRuntimeEvent) => void;
  readonly providerSessionMetadata: Readonly<Record<string, unknown>>;
}
