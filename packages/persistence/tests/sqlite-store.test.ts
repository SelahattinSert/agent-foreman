import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import type {
  QualityGateReport,
  ReviewDecision,
  TaskPlan,
  TaskSession,
  WorkflowEventRecord,
} from '@agent-foreman/contracts';

import {SqliteWorkflowStore} from '../src/index.js';

const createdAt = '2026-07-31T10:00:00.000Z';
const updatedAt = '2026-07-31T10:01:00.000Z';

const session = (): TaskSession => ({
  id: 'task-sqlite-001',
  createdAt,
  updatedAt: createdAt,
  projectRoot: '/project',
  frontendProvider: 'codex',
  supervisorProvider: 'codex-cli',
  workerProvider: 'antigravity-cli',
  profileName: 'balanced',
  state: 'CREATED',
  iteration: 0,
});

const plan = (): TaskPlan => ({
  schemaVersion: 1,
  taskId: 'task-sqlite-001',
  version: 1,
  status: 'APPROVED',
  title: 'Persistence test',
  objective: 'Recover a real session.',
  userIntentSummary: 'Verify crash-safe storage.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [],
  implementationSteps: [],
  expectedFileAreas: [],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt,
  approvedAt: updatedAt,
});

const reviewDecision: ReviewDecision = {
  schemaVersion: 1,
  verdict: 'REVISE',
  summary: 'One issue remains.',
  acceptanceCriteria: [],
  findings: [
    {
      id: 'REV-001',
      severity: 'high',
      category: 'correctness',
      title: 'Incorrect result',
      problem: 'The implementation returns the wrong value.',
      evidence: [{kind: 'diff', reference: 'src/index.ts'}],
      requiredChange: 'Return the expected value.',
      verification: 'Run the focused test.',
      relatedAcceptanceCriteria: [],
    },
  ],
  resolvedFindingIds: [],
  openFindingIds: ['REV-001'],
  newFindingIds: ['REV-001'],
  scopeAssessment: {withinApprovedPlan: true, unexpectedChanges: []},
  recommendedNextAction: 'return_to_worker',
};

const gateReport: QualityGateReport = {
  status: 'FAILED',
  failures: [
    {
      gateId: 'tests',
      type: 'test',
      summary: 'One test failed.',
      fingerprint: 'failure-hash',
      required: true,
      stdout: '',
      stderr: 'expected true to be false',
    },
  ],
  startedAt: createdAt,
  completedAt: updatedAt,
};

describe('SqliteWorkflowStore', () => {
  test('migrates all runtime tables and recovers a complete resumable snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-sqlite-'));
    const databasePath = path.join(root, 'state.sqlite3');
    const auditLogPath = path.join(root, 'events.jsonl');
    const store = await SqliteWorkflowStore.open({databasePath, auditLogPath});
    const initial = session();
    await store.createSession(initial);
    const approvedPlan = plan();
    const planHash = 'a'.repeat(64);
    await store.savePlan(approvedPlan, '# Persistence test', planHash);
    await store.savePlanApproval({
      taskId: initial.id,
      planVersion: 1,
      hash: planHash,
      approvedAt: updatedAt,
    });
    const workspace = {
      id: 'workspace-001',
      path: '/tmp/worktree',
      mode: 'worktree' as const,
      status: 'READY' as const,
      baseRevision: 'abcdef',
      createdAt,
    };
    await store.recordWorkspace(initial.id, workspace);
    await store.recordProviderExecution({
      id: 'provider-001',
      sessionId: initial.id,
      role: 'supervisor',
      providerId: 'codex-cli',
      status: 'COMPLETED',
      startedAt: createdAt,
      completedAt: updatedAt,
      result: {summary: 'reviewed'},
    });
    await store.recordReviewDecision({
      id: 'review-001',
      sessionId: initial.id,
      iteration: 1,
      phase: 'SEMANTIC',
      createdAt: updatedAt,
      decision: reviewDecision,
    });
    await store.recordQualityGateRun({
      id: 'gate-001',
      sessionId: initial.id,
      iteration: 1,
      report: gateReport,
    });
    const next: TaskSession = {
      ...initial,
      state: 'DISCOVERING_REPOSITORY',
      updatedAt,
      currentPlanVersion: 1,
      approvedPlanVersion: 1,
      workspace,
    };
    const event: WorkflowEventRecord = {
      id: 'event-001',
      sessionId: initial.id,
      timestamp: updatedAt,
      previousState: 'CREATED',
      nextState: 'DISCOVERING_REPOSITORY',
      event: {type: 'SESSION_STARTED'},
      metadata: {authorization: 'Bearer must-not-leak'},
    };
    await store.commitTransition(initial, next, event);
    const tables = await store.listTables();
    expect(tables).toEqual(
      expect.arrayContaining([
        'sessions',
        'plans',
        'plan_approvals',
        'workflow_events',
        'provider_executions',
        'worker_iterations',
        'review_decisions',
        'review_findings',
        'quality_gate_runs',
        'workspace_records',
        'user_decisions',
        'token_usage',
      ]),
    );
    store.close();

    const reopened = await SqliteWorkflowStore.open({databasePath, auditLogPath});
    const snapshot = await reopened.loadResumeSnapshot(initial.id);
    expect(snapshot?.session).toMatchObject({state: 'DISCOVERING_REPOSITORY', workspace});
    expect(snapshot?.approvedPlan).toMatchObject({hash: planHash, plan: {version: 1}});
    expect(snapshot?.openFindings.map((finding) => finding.id)).toEqual(['REV-001']);
    expect(snapshot?.lastProviderExecution?.id).toBe('provider-001');
    expect(snapshot?.latestQualityGateReport?.status).toBe('FAILED');
    expect(snapshot?.events).toHaveLength(1);
    reopened.close();

    const audit = await readFile(auditLogPath, 'utf8');
    expect(audit).not.toContain('must-not-leak');
    expect(audit).toContain('[REDACTED]');
  });

  test('rejects a stale transition without writing its event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-sqlite-'));
    const store = await SqliteWorkflowStore.open({
      databasePath: path.join(root, 'state.sqlite3'),
      auditLogPath: path.join(root, 'events.jsonl'),
    });
    const initial = session();
    await store.createSession(initial);
    const stale = {...initial, updatedAt: '2026-07-31T09:59:00.000Z'};
    const next = {...initial, state: 'DISCOVERING_REPOSITORY' as const, updatedAt};
    const event: WorkflowEventRecord = {
      id: 'event-stale',
      sessionId: initial.id,
      timestamp: updatedAt,
      previousState: 'CREATED',
      nextState: 'DISCOVERING_REPOSITORY',
      event: {type: 'SESSION_STARTED'},
    };

    await expect(store.commitTransition(stale, next, event)).rejects.toThrow(/stale/iu);
    await expect(store.listEvents(initial.id)).resolves.toHaveLength(0);
    store.close();
  });
});
