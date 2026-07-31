import {describe, expect, test, vi} from 'vitest';

import type {QualityGateReport, TaskPlan, TaskSession} from '@agent-foreman/contracts';
import {InMemoryWorkflowStore} from '@agent-foreman/persistence';
import {
  FakeSupervisorProvider,
  FakeWorkerProvider,
  type ProviderExecutionContext,
} from '@agent-foreman/provider-sdk';

import {runWorkflow, type WorkflowInteraction} from '../src/index.js';

const at = '2026-07-31T12:00:00.000Z';

const plan = (version: number, title: string): TaskPlan => ({
  schemaVersion: 1,
  taskId: 'task-001',
  version,
  status: 'DRAFT',
  title,
  objective: 'Complete the fake vertical slice.',
  userIntentSummary: 'Exercise every approval boundary without a real model.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [
    {
      id: 'AC-001',
      description: 'The task reaches COMPLETED only after both approvals.',
      verificationMethod: 'test',
      evidenceExpectation: 'The integration test observes all workflow events.',
      priority: 'must',
    },
  ],
  implementationSteps: [],
  expectedFileAreas: ['packages/core'],
  verificationCommands: [],
  risks: [],
  outOfScope: ['Real providers'],
  userDecisions: [],
  createdAt: at,
});

const session = (): TaskSession => ({
  id: 'task-001',
  createdAt: at,
  updatedAt: at,
  projectRoot: '/repo',
  frontendProvider: 'fixture-frontend',
  supervisorProvider: 'fake-supervisor',
  workerProvider: 'fake-worker',
  profileName: 'balanced',
  state: 'CREATED',
  iteration: 0,
});

const providerContext = (): ProviderExecutionContext => ({
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
  logger: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn()},
  emit: vi.fn(),
  providerSessionMetadata: {},
});

const passingGates: QualityGateReport = {
  status: 'PASSED',
  failures: [],
  startedAt: at,
  completedAt: at,
};

describe('fake provider vertical slice', () => {
  test('revises and explicitly approves a plan before worker execution, then requires apply approval', async () => {
    const store = new InMemoryWorkflowStore();
    const supervisor = new FakeSupervisorProvider({
      plans: [plan(1, 'Draft v1'), plan(2, 'Draft v2')],
    });
    const worker = new FakeWorkerProvider();
    const apply = vi.fn(async () => undefined);
    const approveApply = vi.fn(async () => true);
    const decisions = [
      {kind: 'request-change' as const, message: 'Use a stable public API.'},
      {kind: 'approve' as const},
    ];
    const interaction: WorkflowInteraction = {
      reviewPlan: vi.fn(async () => {
        const decision = decisions.shift();
        if (decision === undefined) throw new Error('No scripted plan decision.');
        return decision;
      }),
      approveApply,
    };

    const result = await runWorkflow({
      session: session(),
      userRequest: 'Build Agent Foreman.',
      supervisor,
      worker,
      providerContext: providerContext(),
      store,
      interaction,
      prepareWorkspace: vi.fn(async () => '/tmp/fake-worktree'),
      runQualityGates: vi.fn(async () => passingGates),
      applyChanges: apply,
      now: () => at,
      nextId: (() => {
        let index = 0;
        return () => `event-${String(++index).padStart(3, '0')}`;
      })(),
    });

    expect(result.state).toBe('COMPLETED');
    expect(result.currentPlanVersion).toBe(2);
    expect(result.approvedPlanVersion).toBe(2);
    expect(worker.calls.execute).toHaveLength(1);
    expect(worker.calls.execute[0]?.approvedPlan).toMatchObject({version: 2, status: 'APPROVED'});
    expect(supervisor.calls.reviewImplementation).toHaveLength(1);
    expect(supervisor.calls.finalReview).toHaveLength(1);
    expect(approveApply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();

    const events = await store.listEvents(result.id);
    expect(events.map(({event}) => event.type)).toEqual([
      'SESSION_STARTED',
      'REPOSITORY_DISCOVERED',
      'REQUIREMENTS_SUFFICIENT',
      'PLAN_DRAFTED',
      'PLAN_CHANGE_REQUESTED',
      'PLAN_DRAFTED',
      'PLAN_APPROVED',
      'WORKSPACE_PREPARATION_STARTED',
      'WORKSPACE_READY',
      'WORKER_FINISHED',
      'QUALITY_GATES_PASSED',
      'SUPERVISOR_APPROVED',
      'SUPERVISOR_APPROVED',
      'APPLY_REVIEW_READY',
      'APPLY_APPROVED',
      'CHANGES_APPLIED',
    ]);
  });

  test('cancels without invoking the worker when the plan is not approved', async () => {
    const store = new InMemoryWorkflowStore();
    const supervisor = new FakeSupervisorProvider({plans: [plan(1, 'Draft v1')]});
    const worker = new FakeWorkerProvider();
    const apply = vi.fn(async () => undefined);

    const result = await runWorkflow({
      session: session(),
      userRequest: 'Build Agent Foreman.',
      supervisor,
      worker,
      providerContext: providerContext(),
      store,
      interaction: {
        reviewPlan: vi.fn(async () => ({kind: 'cancel'}) as const),
        approveApply: vi.fn(async () => true),
      },
      prepareWorkspace: vi.fn(async () => '/tmp/fake-worktree'),
      runQualityGates: vi.fn(async () => passingGates),
      applyChanges: apply,
      now: () => at,
      nextId: () => 'event-001',
    });

    expect(result.state).toBe('CANCELLED');
    expect(worker.calls.execute).toHaveLength(0);
    expect(apply).toHaveBeenCalledTimes(0);
  });
});
