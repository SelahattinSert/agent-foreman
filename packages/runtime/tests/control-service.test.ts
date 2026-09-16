import {mkdir, mkdtemp, realpath, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import type {TaskPlan} from '@agent-foreman/contracts';
import {hashTaskPlan} from '@agent-foreman/core';
import {InMemoryWorkflowStore, SqliteWorkflowStore} from '@agent-foreman/persistence';

import {HeadlessRuntimeService} from '../src/index.js';

const now = '2026-08-01T16:00:00.000Z';

const draftPlan = (taskId: string): TaskPlan => ({
  schemaVersion: 1,
  taskId,
  version: 1,
  status: 'DRAFT',
  title: 'Add subtraction',
  objective: 'Add subtraction behavior with tests.',
  userIntentSummary: 'Implement subtract and cover negative numbers.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [
    {
      id: 'AC-001',
      description: 'subtract returns the arithmetic difference.',
      verificationMethod: 'test',
      evidenceExpectation: 'Focused tests pass.',
      priority: 'must',
    },
  ],
  implementationSteps: [
    {
      id: 'STEP-001',
      title: 'Implement and test subtraction',
      description: 'Add the function and focused tests.',
      dependencies: [],
      expectedOutputs: ['Implementation and tests'],
      allowedAreas: ['math.js', 'math.test.js'],
      requiresUserDecision: false,
    },
  ],
  expectedFileAreas: ['math.js', 'math.test.js'],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: now,
});

const serviceFixture = (): {
  readonly service: HeadlessRuntimeService;
  readonly store: InMemoryWorkflowStore;
} => {
  const store = new InMemoryWorkflowStore();
  let id = 0;
  return {
    store,
    service: new HeadlessRuntimeService({
      store,
      workerProvider: 'fixture-worker',
      workerModel: 'fixture-model',
      now: () => now,
      newId: () => `generated-${String(++id).padStart(3, '0')}`,
    }),
  };
};

const createSession = async (service: HeadlessRuntimeService): Promise<string> => {
  const session = await service.sessionCreate({
    projectRoot: '/project',
    frontendProvider: 'codex-native',
    profileName: 'balanced',
    task: 'Add subtraction.',
  });
  return session.id;
};

describe('HeadlessRuntimeService control plane', () => {
  test('creates a durable native-supervisor session without starting providers', async () => {
    const {service, store} = serviceFixture();

    const session = await service.sessionCreate({
      projectRoot: '/project',
      frontendProvider: 'codex-native',
      profileName: 'balanced',
    });

    expect(session).toMatchObject({
      state: 'DISCOVERING_REPOSITORY',
      supervisorProvider: 'codex-native',
      workerProvider: 'fixture-worker',
    });
    expect(session).not.toHaveProperty('userRequest');
    await expect(store.listEvents(session.id)).resolves.toHaveLength(1);
  });

  test('accepts a canonical alias of the configured project root', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'agent-foreman-runtime-root-'));
    const configuredRoot = path.join(fixtureRoot, 'project-alias');
    const actualRoot = path.join(fixtureRoot, 'project');
    await mkdir(actualRoot);
    await symlink(actualRoot, configuredRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const store = new InMemoryWorkflowStore();
    const service = new HeadlessRuntimeService({
      store,
      workerProvider: 'fixture-worker',
      allowedProjectRoot: configuredRoot,
    });

    try {
      const session = await service.sessionCreate({
        projectRoot: await realpath(actualRoot),
        frontendProvider: 'codex-native',
        profileName: 'balanced',
      });

      expect(session.projectRoot).toBe(path.resolve(configuredRoot));
    } finally {
      await rm(fixtureRoot, {recursive: true, force: true});
    }
  });

  test('rejects a different project root when the MCP runtime is root-scoped', async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'agent-foreman-runtime-root-'));
    const configuredRoot = path.join(fixtureRoot, 'project');
    const otherRoot = path.join(fixtureRoot, 'other-project');
    await Promise.all([mkdir(configuredRoot), mkdir(otherRoot)]);

    const store = new InMemoryWorkflowStore();
    const service = new HeadlessRuntimeService({
      store,
      workerProvider: 'fixture-worker',
      allowedProjectRoot: configuredRoot,
    });

    try {
      await expect(
        service.sessionCreate({
          projectRoot: otherRoot,
          frontendProvider: 'codex-native',
          profileName: 'balanced',
        }),
      ).rejects.toThrow('only for its configured project root');
      await expect(store.listSessions()).resolves.toHaveLength(0);
    } finally {
      await rm(fixtureRoot, {recursive: true, force: true});
    }
  });

  test('submits a matching draft and advances planning without a worker', async () => {
    const {service, store} = serviceFixture();
    const sessionId = await createSession(service);
    const plan = draftPlan(sessionId);

    const submitted = await service.planSubmit({sessionId, plan, markdown: '# Add subtraction'});

    expect(submitted.session).toMatchObject({
      state: 'AWAITING_PLAN_REVIEW',
      currentPlanVersion: 1,
    });
    expect(submitted.planHash).toBe(hashTaskPlan(plan));
    await expect(store.getPlanRecord(sessionId, 1)).resolves.toMatchObject({
      plan: {status: 'DRAFT'},
      hash: hashTaskPlan(plan),
    });
  });

  test('stores requested plan changes as a new version and supersedes the old draft', async () => {
    const {service, store} = serviceFixture();
    const sessionId = await createSession(service);
    const first = draftPlan(sessionId);
    const firstSubmission = await service.planSubmit({
      sessionId,
      plan: first,
      markdown: '# Plan v1',
    });
    const firstChallenge = await service.planApprovalRequest({
      sessionId,
      planVersion: 1,
      planHash: firstSubmission.planHash,
    });
    const second: TaskPlan = {
      ...first,
      version: 2,
      title: 'Add subtraction with negative cases',
    };

    const submitted = await service.planSubmit({
      sessionId,
      plan: second,
      markdown: '# Plan v2',
    });

    expect(submitted.session).toMatchObject({
      state: 'AWAITING_PLAN_REVIEW',
      currentPlanVersion: 2,
    });
    await expect(store.getPlanRecord(sessionId, 1)).resolves.toMatchObject({
      plan: {status: 'SUPERSEDED'},
    });
    await expect(store.getPlanRecord(sessionId, 2)).resolves.toMatchObject({
      plan: {status: 'DRAFT'},
    });
    await expect(
      service.planApprovalRequest({
        sessionId,
        planVersion: 2,
        planHash: submitted.planHash,
      }),
    ).resolves.toMatchObject({planVersion: 2, status: 'PENDING'});
    await expect(store.getApprovalChallenge(firstChallenge.id)).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });

  test('rejects worker start before trusted plan approval', async () => {
    const {service} = serviceFixture();
    const sessionId = await createSession(service);
    const plan = draftPlan(sessionId);
    await service.planSubmit({sessionId, plan, markdown: '# Add subtraction'});

    await expect(
      service.assertWorkerStartAllowed({
        sessionId,
        approvedPlanHash: hashTaskPlan(plan),
      }),
    ).rejects.toThrow(/approved/iu);
  });

  test('binds approval request to the canonical draft hash', async () => {
    const {service} = serviceFixture();
    const sessionId = await createSession(service);
    const plan = draftPlan(sessionId);
    const planHash = hashTaskPlan(plan);
    await service.planSubmit({sessionId, plan, markdown: '# Add subtraction'});

    await expect(
      service.planApprovalRequest({sessionId, planVersion: 1, planHash}),
    ).resolves.toMatchObject({
      purpose: 'PLAN',
      sessionId,
      subjectHash: planHash,
      planVersion: 1,
      status: 'PENDING',
      expiresAt: '2026-08-01T16:05:00.000Z',
    });

    await expect(
      service.planApprovalRequest({
        sessionId,
        planVersion: 1,
        planHash: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/hash/iu);
  });

  test('refuses an approval that did not come from a trusted confirmation path', async () => {
    const {service, store} = serviceFixture();
    const sessionId = await createSession(service);
    const plan = draftPlan(sessionId);
    const planHash = hashTaskPlan(plan);
    await service.planSubmit({sessionId, plan, markdown: '# Add subtraction'});
    const challenge = await service.planApprovalRequest({
      sessionId,
      planVersion: 1,
      planHash,
    });

    await expect(
      service.planApprove(
        {sessionId, challengeId: challenge.id, planHash},
        {trusted: false, source: 'skill'},
      ),
    ).rejects.toThrow(/trusted|permission/iu);
    await expect(store.getApprovalChallenge(challenge.id)).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  test('freezes an approved plan once and enables only its approved hash', async () => {
    const {service} = serviceFixture();
    const sessionId = await createSession(service);
    const plan = draftPlan(sessionId);
    const draftHash = hashTaskPlan(plan);
    await service.planSubmit({sessionId, plan, markdown: '# Add subtraction'});
    const challenge = await service.planApprovalRequest({
      sessionId,
      planVersion: 1,
      planHash: draftHash,
    });

    const approved = await service.planApprove(
      {sessionId, challengeId: challenge.id, planHash: draftHash},
      {trusted: true, source: 'tty'},
    );

    expect(approved.session).toMatchObject({state: 'PLAN_APPROVED', approvedPlanVersion: 1});
    expect(approved.plan).toMatchObject({status: 'APPROVED', approvedAt: now});
    expect(approved.approvedPlanHash).toHaveLength(64);
    expect(approved.approvedPlanHash).not.toBe(draftHash);
    await expect(
      service.assertWorkerStartAllowed({
        sessionId,
        approvedPlanHash: approved.approvedPlanHash,
      }),
    ).resolves.toMatchObject({plan: {status: 'APPROVED'}});

    await expect(
      service.planApprove(
        {sessionId, challengeId: challenge.id, planHash: draftHash},
        {trusted: true, source: 'tty'},
      ),
    ).rejects.toThrow(/already used|pending/iu);
  });

  test('atomically freezes the plan, approval and state in SQLite', async () => {
    const store = await SqliteWorkflowStore.open({databasePath: ':memory:'});
    let id = 0;
    const service = new HeadlessRuntimeService({
      store,
      workerProvider: 'fixture-worker',
      now: () => now,
      newId: () => `sqlite-generated-${String(++id).padStart(3, '0')}`,
    });
    try {
      const sessionId = await createSession(service);
      const plan = draftPlan(sessionId);
      const submitted = await service.planSubmit({
        sessionId,
        plan,
        markdown: '# SQLite approval',
      });
      const challenge = await service.planApprovalRequest({
        sessionId,
        planVersion: 1,
        planHash: submitted.planHash,
      });

      const approved = await service.planApprove(
        {sessionId, challengeId: challenge.id, planHash: submitted.planHash},
        {trusted: true, source: 'tty'},
      );

      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        state: 'PLAN_APPROVED',
        approvedPlanVersion: 1,
      });
      await expect(store.getPlanApproval(sessionId, 1)).resolves.toMatchObject({
        hash: approved.approvedPlanHash,
      });
      await expect(store.getApprovalChallenge(challenge.id)).resolves.toMatchObject({
        status: 'CONSUMED',
      });
    } finally {
      store.close();
    }
  });
});
