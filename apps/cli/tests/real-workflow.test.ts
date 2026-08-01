import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, test, vi} from 'vitest';

import type {
  QualityGateReport,
  ReviewDecision,
  TaskPlan,
  TaskSession,
  WorkerExecutionResult,
} from '@agent-foreman/contracts';
import {SqliteWorkflowStore} from '@agent-foreman/persistence';
import {runProcess} from '@agent-foreman/process';
import {
  FakeSupervisorProvider,
  FakeWorkerProvider,
  type ProviderExecutionContext,
  type WorkerProvider,
} from '@agent-foreman/provider-sdk';
import {runQualityGates} from '@agent-foreman/quality-gates';
import {
  applyWorkspaceChanges,
  collectWorkspaceDiff,
  prepareGitWorkspace,
} from '@agent-foreman/workspace';

import {
  resumeApplyWorkflow,
  resumeExecutionWorkflow,
  runRealWorkflow,
  type RealWorkflowInteraction,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {recursive: true, force: true});
    }),
  );
});

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  const result = await runProcess({
    executable: 'git',
    args: ['-C', cwd, ...args],
    stdio: 'capture',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
};

const repository = async (): Promise<{root: string; data: string}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'af-real-workflow-repo-'));
  const data = await mkdtemp(path.join(os.tmpdir(), 'af-real-workflow-data-'));
  temporaryDirectories.push(root, data);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'fixture@example.test']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(root, 'result.txt'), 'baseline\n');
  await git(root, ['add', 'result.txt']);
  await git(root, ['commit', '-m', 'baseline']);
  return {root, data};
};

const at = '2026-07-31T12:00:00.000Z';

const plan: TaskPlan = {
  schemaVersion: 1,
  taskId: 'task-real-001',
  version: 1,
  status: 'DRAFT',
  title: 'Produce the approved result',
  objective: 'Change result.txt through the isolated worker workspace.',
  userIntentSummary: 'Exercise the real orchestration boundaries.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [
    {
      id: 'AC-001',
      description: 'result.txt contains final.',
      verificationMethod: 'test',
      evidenceExpectation: 'The command gate passes.',
      priority: 'must',
    },
  ],
  implementationSteps: [],
  expectedFileAreas: ['result.txt'],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: at,
};

const finding = {
  id: 'REV-001',
  severity: 'high' as const,
  category: 'correctness' as const,
  title: 'Result is incomplete',
  problem: 'The mechanically repaired value is not the final result.',
  evidence: [{kind: 'diff' as const, reference: 'result.txt'}],
  requiredChange: 'Write final.',
  verification: 'Run the result gate.',
  relatedAcceptanceCriteria: ['AC-001'],
};

const review = (verdict: 'APPROVED' | 'REVISE', resolve = false): ReviewDecision => ({
  schemaVersion: 1,
  verdict,
  summary: verdict === 'APPROVED' ? 'Approved.' : 'Revision is required.',
  acceptanceCriteria: [
    {
      acceptanceCriterionId: 'AC-001',
      status: verdict === 'APPROVED' ? 'PASSED' : 'FAILED',
      summary: verdict === 'APPROVED' ? 'Verified.' : 'Not final yet.',
      evidence: [{kind: 'quality-gate', reference: 'result'}],
    },
  ],
  findings: verdict === 'REVISE' || resolve ? [finding] : [],
  resolvedFindingIds: resolve ? ['REV-001'] : [],
  openFindingIds: verdict === 'REVISE' ? ['REV-001'] : [],
  newFindingIds: verdict === 'REVISE' ? ['REV-001'] : [],
  scopeAssessment: {withinApprovedPlan: true, unexpectedChanges: []},
  recommendedNextAction: verdict === 'APPROVED' ? 'finish' : 'return_to_worker',
});

const workerResult = (id: string): WorkerExecutionResult => ({
  schemaVersion: 1,
  executionId: id,
  status: 'COMPLETED',
  summary: 'Worker updated the isolated file.',
  changedFiles: [{path: 'result.txt', changeType: 'modified'}],
  commandsRun: [],
  testsAdded: [],
  acceptanceCriteriaWorkedOn: ['AC-001'],
  assumptionsMade: [],
  blockers: [],
  knownIssues: [],
});

class EditingWorker implements WorkerProvider {
  private readonly delegate = new FakeWorkerProvider({
    results: [workerResult('initial'), workerResult('mechanical'), workerResult('revision')],
  });
  public readonly calls = this.delegate.calls;
  private revision = 0;

  public descriptor = this.delegate.descriptor.bind(this.delegate);
  public healthCheck = this.delegate.healthCheck.bind(this.delegate);

  public async execute(
    ...args: Parameters<WorkerProvider['execute']>
  ): Promise<WorkerExecutionResult> {
    await writeFile(path.join(args[0].workspacePath, 'result.txt'), 'bad\n');
    return await this.delegate.execute(...args);
  }

  public async revise(
    ...args: Parameters<WorkerProvider['revise']>
  ): Promise<WorkerExecutionResult> {
    this.revision += 1;
    const context = args[1];
    if (context.executionWorkspace === undefined) throw new Error('Missing execution workspace.');
    await writeFile(
      path.join(context.executionWorkspace.path, 'result.txt'),
      this.revision === 1 ? 'mechanical\n' : 'final\n',
    );
    return await this.delegate.revise(...args);
  }
}

const context = (root: string): ProviderExecutionContext => ({
  sessionId: 'task-real-001',
  projectRoot: root,
  timeoutMs: 30_000,
  abortSignal: new AbortController().signal,
  permissions: {
    filesystem: 'read-only',
    shell: 'read-only-allowlist',
    network: 'denied',
    workerLaunch: 'denied',
  },
  environmentAllowlist: ['PATH'],
  logger: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn()},
  emit: vi.fn(),
  providerSessionMetadata: {},
});

describe('real workflow orchestration', () => {
  test('repairs mechanical failures before review, revises findings, and applies only after approval', async () => {
    const {root, data} = await repository();
    const store = await SqliteWorkflowStore.open({databasePath: ':memory:'});
    const supervisor = new FakeSupervisorProvider({
      plans: [plan],
      reviews: [review('REVISE'), review('APPROVED', true)],
      finalReviews: [review('APPROVED')],
    });
    const worker = new EditingWorker();
    const session: TaskSession = {
      id: 'task-real-001',
      createdAt: at,
      updatedAt: at,
      projectRoot: root,
      frontendProvider: 'codex',
      supervisorProvider: 'fake-supervisor',
      workerProvider: 'fake-worker',
      profileName: 'test',
      state: 'CREATED',
      iteration: 0,
    };
    const interaction: RealWorkflowInteraction = {
      answerRequirements: vi.fn(async () => 'No additional constraints.'),
      reviewPlan: vi.fn(async () => ({kind: 'approve'}) as const),
      reviewApply: vi.fn(async () => 'keep' as const),
      notify: vi.fn(),
    };
    let tick = 0;
    const now = (): string => new Date(Date.parse(at) + tick++).toISOString();

    const result = await runRealWorkflow({
      session,
      userRequest: 'Write final to result.txt.',
      projectSummary: {
        root,
        vcs: 'git',
        languages: ['text'],
        packageManagers: [],
        relevantFiles: ['result.txt'],
        summary: 'A small Git fixture.',
      },
      supervisor,
      worker,
      supervisorContext: context(root),
      store,
      interaction,
      prepareWorkspace: async () =>
        await prepareGitWorkspace({
          projectRoot: root,
          taskId: session.id,
          dataDirectory: data,
          dirtyStrategy: 'head-worktree',
          now,
        }),
      collectDiff: collectWorkspaceDiff,
      runQualityGates: async (workspacePath): Promise<QualityGateReport> =>
        await runQualityGates({
          workspacePath,
          gates: [
            {
              id: 'result',
              type: 'test',
              command: [
                process.execPath,
                '-e',
                "const fs=require('fs');process.exit(fs.readFileSync('result.txt','utf8')==='bad\\n'?1:0)",
              ],
              required: true,
            },
          ],
          now,
        }),
      applyChanges: async (workspace) =>
        await applyWorkspaceChanges({workspace, sourceProjectRoot: root, approved: true}),
      limits: {
        maxWorkerIterations: 8,
        maxMechanicalRepairs: 3,
        maxSupervisorReviews: 5,
        maxSameFindingOccurrences: 3,
        pauseOnNoProgressIterations: 2,
        detectDiffOscillation: true,
      },
      reviewPolicy: {allowOpenMedium: true, allowOpenLow: true},
      now,
      nextId: (() => {
        let id = 0;
        return () => `record-${String(++id).padStart(3, '0')}`;
      })(),
    });

    expect(result.state).toBe('PAUSED');
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('baseline\n');
    expect(supervisor.calls.reviewImplementation).toHaveLength(2);
    expect(supervisor.calls.finalReview).toHaveLength(1);
    expect(worker.calls.revise).toHaveLength(2);
    expect(worker.calls.revise[0]?.qualityGateFailures).toHaveLength(1);
    expect(worker.calls.revise[1]?.openFindings).toMatchObject([{id: 'REV-001'}]);

    const eventTypes = (await store.listEvents(session.id)).map(({event}) => event.type);
    expect(eventTypes).toContain('QUALITY_GATES_FAILED');
    expect(eventTypes).toContain('MECHANICAL_REPAIR_FINISHED');
    expect(eventTypes).toContain('SUPERVISOR_REQUESTED_REVISION');
    expect(eventTypes.at(-1)).toBe('TASK_PAUSED');
    const snapshot = await store.loadResumeSnapshot(session.id);
    if (snapshot === undefined) throw new Error('Missing resume snapshot.');
    const resumed = await resumeApplyWorkflow({
      snapshot,
      store,
      interaction: {
        ...interaction,
        reviewApply: vi.fn(async () => 'apply' as const),
      },
      collectDiff: collectWorkspaceDiff,
      applyChanges: async (workspace) =>
        await applyWorkspaceChanges({workspace, sourceProjectRoot: root, approved: true}),
      discardWorkspace: async (workspace) => ({...workspace, status: 'DISCARDED'}),
      now,
      nextId: (() => {
        let id = 500;
        return () => `record-${String(++id)}`;
      })(),
    });
    expect(resumed.state).toBe('COMPLETED');
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('final\n');
    const completedSnapshot = await store.loadResumeSnapshot(session.id);
    expect(completedSnapshot?.workspace?.status).toBe('APPLIED');
    expect(completedSnapshot?.session.workspace?.status).toBe('APPLIED');
    store.close();
  });

  test('recovers an interrupted post-worker session from SQLite and continues gates and review', async () => {
    const {root, data} = await repository();
    const store = await SqliteWorkflowStore.open({databasePath: ':memory:'});
    const supervisor = new FakeSupervisorProvider({
      plans: [plan],
      reviews: [review('APPROVED')],
      finalReviews: [review('APPROVED')],
    });
    const worker = new EditingWorker();
    const session: TaskSession = {
      id: 'task-real-001',
      createdAt: at,
      updatedAt: at,
      projectRoot: root,
      userRequest: 'Recover this task.',
      frontendProvider: 'codex',
      supervisorProvider: 'fake-supervisor',
      workerProvider: 'fake-worker',
      profileName: 'test',
      state: 'CREATED',
      iteration: 0,
    };
    const interaction: RealWorkflowInteraction = {
      answerRequirements: vi.fn(async () => 'No additional constraints.'),
      reviewPlan: vi.fn(async () => ({kind: 'approve'}) as const),
      reviewApply: vi.fn(async () => 'apply' as const),
      notify: vi.fn(),
    };
    let tick = 0;
    const now = (): string => new Date(Date.parse(at) + tick++).toISOString();
    let id = 0;
    const nextId = (): string => `crash-${String(++id)}`;
    await expect(
      runRealWorkflow({
        session,
        userRequest: 'Recover this task.',
        projectSummary: {
          root,
          vcs: 'git',
          languages: ['text'],
          packageManagers: [],
          relevantFiles: ['result.txt'],
          summary: 'Crash recovery fixture.',
        },
        supervisor,
        worker,
        supervisorContext: context(root),
        store,
        interaction,
        prepareWorkspace: async () =>
          await prepareGitWorkspace({
            projectRoot: root,
            taskId: session.id,
            dataDirectory: data,
            dirtyStrategy: 'head-worktree',
            now,
          }),
        collectDiff: collectWorkspaceDiff,
        runQualityGates: async () => {
          throw new Error('simulated process crash');
        },
        applyChanges: async (workspace) =>
          await applyWorkspaceChanges({workspace, sourceProjectRoot: root, approved: true}),
        limits: {
          maxWorkerIterations: 8,
          maxMechanicalRepairs: 3,
          maxSupervisorReviews: 5,
          maxSameFindingOccurrences: 3,
          pauseOnNoProgressIterations: 2,
          detectDiffOscillation: true,
        },
        reviewPolicy: {allowOpenMedium: true, allowOpenLow: true},
        now,
        nextId,
      }),
    ).rejects.toThrow('simulated process crash');

    const snapshot = await store.loadResumeSnapshot(session.id);
    if (snapshot === undefined) throw new Error('Missing crash snapshot.');
    expect(snapshot.session.state).toBe('RUNNING_QUALITY_GATES');
    const passing: QualityGateReport = {
      status: 'PASSED',
      failures: [],
      startedAt: now(),
      completedAt: now(),
      runs: [],
    };
    const resumed = await resumeExecutionWorkflow({
      snapshot,
      projectSummary: {
        root,
        vcs: 'git',
        languages: ['text'],
        packageManagers: [],
        relevantFiles: ['result.txt'],
        summary: 'Crash recovery fixture.',
      },
      supervisor,
      worker,
      supervisorContext: context(root),
      store,
      interaction,
      collectDiff: collectWorkspaceDiff,
      runQualityGates: vi.fn(async () => passing),
      applyChanges: async (workspace) =>
        await applyWorkspaceChanges({workspace, sourceProjectRoot: root, approved: true}),
      discardWorkspace: async (workspace) => ({...workspace, status: 'DISCARDED'}),
      limits: {
        maxWorkerIterations: 8,
        maxMechanicalRepairs: 3,
        maxSupervisorReviews: 5,
        maxSameFindingOccurrences: 3,
        pauseOnNoProgressIterations: 2,
        detectDiffOscillation: true,
      },
      reviewPolicy: {allowOpenMedium: true, allowOpenLow: true},
      now,
      nextId,
    });

    expect(resumed.state).toBe('COMPLETED');
    expect(await readFile(path.join(root, 'result.txt'), 'utf8')).toBe('bad\n');
    store.close();
  });
});
