import {describe, expect, test, vi} from 'vitest';

import type {TaskPlan} from '@agent-foreman/contracts';

import {
  FakeSupervisorProvider,
  FakeWorkerProvider,
  type ProviderExecutionContext,
} from '../src/index.js';

const now = '2026-07-31T12:00:00.000Z';

const plan: TaskPlan = {
  schemaVersion: 1,
  taskId: 'task-001',
  version: 1,
  status: 'DRAFT',
  title: 'Fixture plan',
  objective: 'Exercise provider-neutral contracts.',
  userIntentSummary: 'Run a fake provider.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [],
  implementationSteps: [],
  expectedFileAreas: [],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: now,
};

const context = (): ProviderExecutionContext => ({
  sessionId: 'task-001',
  projectRoot: '/repo',
  timeoutMs: 10_000,
  abortSignal: new AbortController().signal,
  permissions: {
    filesystem: 'read-only',
    shell: 'read-only-allowlist',
    network: 'denied',
    workerLaunch: 'denied',
  },
  environmentAllowlist: [],
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  emit: vi.fn(),
  providerSessionMetadata: {},
});

describe('fake providers', () => {
  test('implements planning without naming a concrete provider or model', async () => {
    const supervisor = new FakeSupervisorProvider({plans: [plan]});

    const descriptor = await supervisor.descriptor();
    const drafted = await supervisor.draftPlan(
      {
        taskId: 'task-001',
        version: 1,
        createdAt: now,
        userRequest: 'Build the guarded workflow.',
        discovery: {
          summary: 'A guarded workflow is required.',
          repositoryObservations: ['Empty repository'],
          questions: [],
          proposedAssumptions: [],
          sufficient: true,
        },
      },
      context(),
    );

    expect(descriptor.id).toBe('fake-supervisor');
    expect(drafted).toEqual(plan);
    expect(supervisor.calls.draftPlan).toHaveLength(1);
  });

  test('returns a schema-valid worker result and records its input', async () => {
    const worker = new FakeWorkerProvider();
    const approvedPlan = {...plan, status: 'APPROVED' as const, approvedAt: now};

    const result = await worker.execute(
      {
        approvedPlan,
        approvedPlanHash: 'a'.repeat(64),
        projectSummary: {
          root: '/repo',
          vcs: 'git',
          languages: ['TypeScript'],
          packageManagers: ['pnpm'],
          relevantFiles: [],
          summary: 'Fixture repository',
        },
        workspacePath: '/tmp/worktree',
        constraints: {
          allowedAreas: ['packages/core'],
          deniedAreas: ['.git'],
          networkAccess: 'denied',
          destructiveCommands: 'denied',
        },
        baselineResults: {
          status: 'PASSED',
          failures: [],
          startedAt: now,
          completedAt: now,
        },
        outputSchema: {},
      },
      context(),
    );

    expect(result).toMatchObject({schemaVersion: 1, status: 'COMPLETED'});
    expect(worker.calls.execute).toHaveLength(1);
  });
});
