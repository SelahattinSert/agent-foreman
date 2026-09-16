import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, test} from 'vitest';

import {
  ApprovalChallengeSchema,
  TaskSessionSchema,
  type ProviderHealth,
  type TaskPlan,
  type WorkerExecutionInput,
  type WorkerExecutionResult,
} from '@agent-foreman/contracts';
import {ProviderOutputValidationError} from '@agent-foreman/core';
import {
  InMemoryWorkflowStore,
  SqliteWorkflowStore,
  type ApprovalChallengeRepository,
  type RuntimeRecordRepository,
  type WorkflowStore,
} from '@agent-foreman/persistence';
import {
  FakeWorkerProvider,
  type ProviderExecutionContext,
  type WorkerProvider,
} from '@agent-foreman/provider-sdk';

import {
  createAgentForemanMcpServer,
  HeadlessRuntimeService,
  NativeExecutionCoordinator,
} from '../src/index.js';

const now = '2026-08-01T17:00:00.000Z';

const planFor = (taskId: string): TaskPlan => ({
  schemaVersion: 1,
  taskId,
  version: 1,
  status: 'DRAFT',
  title: 'Safe MCP plan',
  objective: 'Prove the explicit approval path.',
  userIntentSummary: 'Use native Codex with an enforcing runtime.',
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
});

interface McpFixture {
  readonly client: Client;
  readonly store: WorkflowStore & RuntimeRecordRepository & ApprovalChallengeRepository;
  close(): Promise<void>;
}

class FailOnceWorkerProvider extends FakeWorkerProvider {
  public attempts = 0;

  public override async execute(
    input: WorkerExecutionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new ProviderOutputValidationError('Fixture provider output was invalid.');
    }
    return await super.execute(input, context);
  }
}

class FailOnceHealthCheckWorkerProvider extends FakeWorkerProvider {
  public healthChecks = 0;

  public override async healthCheck(): Promise<ProviderHealth> {
    this.healthChecks += 1;
    if (this.healthChecks === 1) {
      return {status: 'FAIL', message: 'Configured worker model is unavailable.'};
    }
    return await super.healthCheck();
  }
}

const connectedFixture = async (
  confirmation: boolean,
  worker: WorkerProvider = new FakeWorkerProvider(),
  persistence: 'memory' | 'sqlite' = 'memory',
  failFirstApply = false,
): Promise<McpFixture> => {
  const store =
    persistence === 'sqlite'
      ? await SqliteWorkflowStore.open({databasePath: ':memory:'})
      : new InMemoryWorkflowStore();
  let id = 0;
  const execution = new NativeExecutionCoordinator({
    store,
    worker,
    summarizeProject: async (projectRoot) => ({
      root: projectRoot,
      vcs: 'git',
      languages: ['TypeScript'],
      packageManagers: ['pnpm'],
      relevantFiles: [],
      summary: 'Fixture repository.',
    }),
    prepareWorkspace: async (session) => ({
      id: session.id,
      path: '/worktree',
      mode: 'worktree',
      status: 'READY',
      baseRevision: 'abc123',
      baseTree: 'abc123',
      sourceProjectRoot: session.projectRoot,
      baselineFingerprint: 'baseline-1',
      createdAt: now,
    }),
    collectDiff: async () => ({
      patch: 'diff --git a/math.js b/math.js\n',
      hash: 'd'.repeat(64),
      changedFiles: [],
      additions: 1,
      deletions: 0,
    }),
    validateApplyBaseline: async () => undefined,
    runQualityGates: async () => ({
      status: 'PASSED',
      failures: [],
      startedAt: now,
      completedAt: now,
      runs: [],
    }),
    applyChanges: async (workspace) => {
      if (failFirstApply) {
        failFirstApply = false;
        throw new Error('Fixture apply failed before mutating the source.');
      }
      return {
        workspace: {...workspace, status: 'APPLIED'},
        diff: {
          patch: 'diff --git a/math.js b/math.js\n',
          hash: 'd'.repeat(64),
          changedFiles: [],
          additions: 1,
          deletions: 0,
        },
      };
    },
    createWorkerContext: (session, workspace) => ({
      sessionId: session.id,
      projectRoot: session.projectRoot,
      executionWorkspace: workspace,
      timeoutMs: 60_000,
      abortSignal: new AbortController().signal,
      permissions: {
        filesystem: 'workspace-write',
        shell: 'project-scoped',
        network: 'ask',
        workerLaunch: 'denied',
      },
      environmentAllowlist: ['PATH'],
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
      },
      emit: () => undefined,
      providerSessionMetadata: {},
    }),
    loopLimits: {
      maxWorkerIterations: 8,
      maxMechanicalRepairs: 3,
      maxSupervisorReviews: 5,
      maxSameFindingOccurrences: 2,
      pauseOnNoProgressIterations: 2,
      detectDiffOscillation: true,
    },
    reviewPolicy: {allowOpenMedium: true, allowOpenLow: true},
    now: () => now,
    newId: () => `execution-generated-${String(++id).padStart(3, '0')}`,
  });
  const service = new HeadlessRuntimeService({
    store,
    workerProvider: 'fixture-worker',
    now: () => now,
    newId: () => `mcp-generated-${String(++id).padStart(3, '0')}`,
    execution,
  });
  const server = createAgentForemanMcpServer({service});
  const client = new Client(
    {name: 'agent-foreman-test-client', version: '1.0.0'},
    {capabilities: {elicitation: {form: {}}}},
  );
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: 'accept',
    content: {confirm: confirmation},
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    store,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
      if (store instanceof SqliteWorkflowStore) store.close();
    },
  };
};

const fixtures: McpFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.close()));
});

describe('Agent Foreman MCP server', () => {
  test('exposes the native-supervisor control tools without a chat replacement', async () => {
    const fixture = await connectedFixture(true);
    fixtures.push(fixture);

    const tools = await fixture.client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'agent_foreman_session_create',
      'agent_foreman_plan_submit',
      'agent_foreman_plan_approval_request',
      'agent_foreman_plan_approve',
      'agent_foreman_worker_start',
      'agent_foreman_review_submit',
      'agent_foreman_apply_request',
      'agent_foreman_apply_approve',
      'agent_foreman_resume',
      'agent_foreman_status',
    ]);
  });

  test('requires client elicitation before freezing a plan and opening worker execution', async () => {
    const fixture = await connectedFixture(true, new FakeWorkerProvider(), 'memory', true);
    fixtures.push(fixture);
    const createdResult = await fixture.client.callTool({
      name: 'agent_foreman_session_create',
      arguments: {
        projectRoot: '/project',
        frontendProvider: 'codex-native',
        profileName: 'balanced',
        task: 'Implement the approved task.',
      },
    });
    const session = TaskSessionSchema.parse(createdResult.structuredContent);
    const plan = planFor(session.id);
    const submittedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_submit',
      arguments: {sessionId: session.id, plan, markdown: '# Safe MCP plan'},
    });
    const submitted = submittedResult.structuredContent as {
      session: unknown;
      planHash: string;
    };
    expect(TaskSessionSchema.parse(submitted.session).state).toBe('AWAITING_PLAN_REVIEW');
    const requestedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_approval_request',
      arguments: {sessionId: session.id, planVersion: 1, planHash: submitted.planHash},
    });
    const challenge = ApprovalChallengeSchema.parse(requestedResult.structuredContent);

    const approvedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_approve',
      arguments: {
        sessionId: session.id,
        challengeId: challenge.id,
        planHash: submitted.planHash,
      },
    });
    const approved = approvedResult.structuredContent as {
      session: unknown;
      approvedPlanHash: string;
    };
    expect(TaskSessionSchema.parse(approved.session).state).toBe('PLAN_APPROVED');

    const workerResult = await fixture.client.callTool({
      name: 'agent_foreman_worker_start',
      arguments: {sessionId: session.id, approvedPlanHash: approved.approvedPlanHash},
    });
    expect(workerResult.isError).not.toBe(true);
    expect(workerResult.structuredContent).toMatchObject({
      approvedPlanHash: approved.approvedPlanHash,
      phase: 'SEMANTIC',
      session: {state: 'SUPERVISOR_REVIEW'},
    });

    const review = {
      schemaVersion: 1 as const,
      verdict: 'APPROVED' as const,
      summary: 'The implementation satisfies the approved plan.',
      acceptanceCriteria: [],
      findings: [],
      resolvedFindingIds: [],
      openFindingIds: [],
      newFindingIds: [],
      scopeAssessment: {withinApprovedPlan: true, unexpectedChanges: []},
      recommendedNextAction: 'finish' as const,
    };
    const finalReviewResult = await fixture.client.callTool({
      name: 'agent_foreman_review_submit',
      arguments: {
        sessionId: session.id,
        approvedPlanHash: approved.approvedPlanHash,
        iteration: 1,
        review,
      },
    });
    expect(finalReviewResult.structuredContent).toMatchObject({
      phase: 'FINAL',
      session: {state: 'FINAL_REVIEW'},
    });
    const resumedFinalReview = await fixture.client.callTool({
      name: 'agent_foreman_resume',
      arguments: {sessionId: session.id},
    });
    expect(resumedFinalReview.structuredContent).toMatchObject({
      nextAction: 'SUBMIT_REVIEW',
      session: {state: 'FINAL_REVIEW'},
      reviewPacket: {phase: 'FINAL', approvedPlanHash: approved.approvedPlanHash},
    });
    const applyReviewResult = await fixture.client.callTool({
      name: 'agent_foreman_review_submit',
      arguments: {
        sessionId: session.id,
        approvedPlanHash: approved.approvedPlanHash,
        iteration: 1,
        review,
      },
    });
    expect(applyReviewResult.structuredContent).toMatchObject({
      phase: 'APPLY',
      session: {state: 'AWAITING_APPLY_APPROVAL'},
    });
    const applyRequest = await fixture.client.callTool({
      name: 'agent_foreman_apply_request',
      arguments: {
        sessionId: session.id,
        reviewedDiffHash: 'd'.repeat(64),
        sourceBaseline: 'baseline-1',
      },
    });
    const applyChallenge = ApprovalChallengeSchema.parse(
      (applyRequest.structuredContent as {challenge: unknown}).challenge,
    );
    const failedApply = await fixture.client.callTool({
      name: 'agent_foreman_apply_approve',
      arguments: {
        sessionId: session.id,
        challengeId: applyChallenge.id,
        reviewedDiffHash: 'd'.repeat(64),
        sourceBaseline: 'baseline-1',
      },
    });
    expect(failedApply.isError).toBe(true);

    const applyRecovery = await fixture.client.callTool({
      name: 'agent_foreman_resume',
      arguments: {sessionId: session.id},
    });
    expect(applyRecovery.structuredContent).toMatchObject({
      nextAction: 'REQUEST_APPLY_APPROVAL',
      session: {state: 'AWAITING_APPLY_APPROVAL'},
    });
    const retryRequest = await fixture.client.callTool({
      name: 'agent_foreman_apply_request',
      arguments: {
        sessionId: session.id,
        reviewedDiffHash: 'd'.repeat(64),
        sourceBaseline: 'baseline-1',
      },
    });
    const retryChallenge = ApprovalChallengeSchema.parse(
      (retryRequest.structuredContent as {challenge: unknown}).challenge,
    );
    const applied = await fixture.client.callTool({
      name: 'agent_foreman_apply_approve',
      arguments: {
        sessionId: session.id,
        challengeId: retryChallenge.id,
        reviewedDiffHash: 'd'.repeat(64),
        sourceBaseline: 'baseline-1',
      },
    });
    expect(applied.structuredContent).toMatchObject({
      session: {state: 'COMPLETED', workspace: {status: 'APPLIED'}},
      workspace: {status: 'APPLIED'},
    });
    const persisted = await fixture.store.loadResumeSnapshot(session.id);
    expect(persisted?.session).toMatchObject({
      state: 'COMPLETED',
      workspace: {status: 'APPLIED'},
    });
  });

  test('declining the MCP confirmation leaves the one-time approval pending', async () => {
    const fixture = await connectedFixture(false);
    fixtures.push(fixture);
    const created = await fixture.client.callTool({
      name: 'agent_foreman_session_create',
      arguments: {
        projectRoot: '/project',
        frontendProvider: 'codex-native',
        profileName: 'balanced',
      },
    });
    const session = TaskSessionSchema.parse(created.structuredContent);
    const plan = planFor(session.id);
    const submittedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_submit',
      arguments: {sessionId: session.id, plan, markdown: '# Safe MCP plan'},
    });
    const submitted = submittedResult.structuredContent as {planHash: string};
    const requested = await fixture.client.callTool({
      name: 'agent_foreman_plan_approval_request',
      arguments: {sessionId: session.id, planVersion: 1, planHash: submitted.planHash},
    });
    const challenge = ApprovalChallengeSchema.parse(requested.structuredContent);

    const rejected = await fixture.client.callTool({
      name: 'agent_foreman_plan_approve',
      arguments: {
        sessionId: session.id,
        challengeId: challenge.id,
        planHash: submitted.planHash,
      },
    });

    expect(rejected.isError).toBe(true);
    await expect(fixture.store.getApprovalChallenge(challenge.id)).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  test('retries a failed initial worker in its unchanged isolated workspace after resume', async () => {
    const worker = new FailOnceWorkerProvider();
    const fixture = await connectedFixture(true, worker, 'sqlite');
    fixtures.push(fixture);
    const created = await fixture.client.callTool({
      name: 'agent_foreman_session_create',
      arguments: {
        projectRoot: '/project',
        frontendProvider: 'codex-native',
        profileName: 'balanced',
        task: 'Implement the approved task.',
      },
    });
    const session = TaskSessionSchema.parse(created.structuredContent);
    const plan = planFor(session.id);
    const submittedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_submit',
      arguments: {sessionId: session.id, plan, markdown: '# Safe MCP plan'},
    });
    const submitted = submittedResult.structuredContent as {planHash: string};
    const requested = await fixture.client.callTool({
      name: 'agent_foreman_plan_approval_request',
      arguments: {sessionId: session.id, planVersion: 1, planHash: submitted.planHash},
    });
    const challenge = ApprovalChallengeSchema.parse(requested.structuredContent);
    const approvedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_approve',
      arguments: {
        sessionId: session.id,
        challengeId: challenge.id,
        planHash: submitted.planHash,
      },
    });
    const approved = approvedResult.structuredContent as {approvedPlanHash: string};

    const failed = await fixture.client.callTool({
      name: 'agent_foreman_worker_start',
      arguments: {sessionId: session.id, approvedPlanHash: approved.approvedPlanHash},
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('Fixture provider output was invalid.');

    const resumed = await fixture.client.callTool({
      name: 'agent_foreman_resume',
      arguments: {sessionId: session.id},
    });
    expect(resumed.structuredContent).toMatchObject({
      nextAction: 'START_WORKER',
      session: {state: 'PAUSED'},
      approvedPlanHash: approved.approvedPlanHash,
    });

    const retried = await fixture.client.callTool({
      name: 'agent_foreman_worker_start',
      arguments: {sessionId: session.id, approvedPlanHash: approved.approvedPlanHash},
    });
    expect(retried.isError).not.toBe(true);
    expect(retried.structuredContent).toMatchObject({
      phase: 'SEMANTIC',
      session: {state: 'SUPERVISOR_REVIEW', iteration: 2},
    });
    expect(worker.attempts).toBe(2);
    const snapshot = await fixture.store.loadResumeSnapshot(session.id);
    expect(snapshot).toMatchObject({
      workerIterations: [
        {iteration: 1, kind: 'INITIAL'},
        {iteration: 2, kind: 'INITIAL', result: {status: 'COMPLETED'}},
      ],
      lastProviderExecution: {status: 'COMPLETED'},
    });
    expect(snapshot?.workerIterations[0]?.result).toBeUndefined();
  });

  test('allows retry after worker preflight fails before creating a workspace', async () => {
    const worker = new FailOnceHealthCheckWorkerProvider();
    const fixture = await connectedFixture(true, worker, 'sqlite');
    fixtures.push(fixture);
    const created = await fixture.client.callTool({
      name: 'agent_foreman_session_create',
      arguments: {
        projectRoot: '/project',
        frontendProvider: 'codex-native',
        profileName: 'balanced',
        task: 'Implement the approved task after the worker is healthy.',
      },
    });
    const session = TaskSessionSchema.parse(created.structuredContent);
    const plan = planFor(session.id);
    const submittedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_submit',
      arguments: {sessionId: session.id, plan, markdown: '# Safe MCP plan'},
    });
    const submitted = submittedResult.structuredContent as {planHash: string};
    const requested = await fixture.client.callTool({
      name: 'agent_foreman_plan_approval_request',
      arguments: {sessionId: session.id, planVersion: 1, planHash: submitted.planHash},
    });
    const challenge = ApprovalChallengeSchema.parse(requested.structuredContent);
    const approvedResult = await fixture.client.callTool({
      name: 'agent_foreman_plan_approve',
      arguments: {
        sessionId: session.id,
        challengeId: challenge.id,
        planHash: submitted.planHash,
      },
    });
    const approved = approvedResult.structuredContent as {approvedPlanHash: string};

    const failed = await fixture.client.callTool({
      name: 'agent_foreman_worker_start',
      arguments: {sessionId: session.id, approvedPlanHash: approved.approvedPlanHash},
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('Configured worker model is unavailable.');

    const resumed = await fixture.client.callTool({
      name: 'agent_foreman_resume',
      arguments: {sessionId: session.id},
    });
    expect(resumed.structuredContent).toMatchObject({
      nextAction: 'START_WORKER',
      session: {state: 'PAUSED'},
      approvedPlanHash: approved.approvedPlanHash,
    });

    const retried = await fixture.client.callTool({
      name: 'agent_foreman_worker_start',
      arguments: {sessionId: session.id, approvedPlanHash: approved.approvedPlanHash},
    });
    expect(retried.isError).not.toBe(true);
    expect(retried.structuredContent).toMatchObject({
      phase: 'SEMANTIC',
      session: {state: 'SUPERVISOR_REVIEW', iteration: 1},
    });
    expect(worker.healthChecks).toBe(2);
    expect(worker.calls.execute).toHaveLength(1);
    const snapshot = await fixture.store.loadResumeSnapshot(session.id);
    expect(snapshot).toMatchObject({
      workerIterations: [{iteration: 1, kind: 'INITIAL', result: {status: 'COMPLETED'}}],
      workspace: {status: 'READY'},
    });
  });
});
