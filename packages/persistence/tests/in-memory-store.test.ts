import {describe, expect, test} from 'vitest';

import type {ExecutionWorkspace, TaskSession, WorkflowEventRecord} from '@agent-foreman/contracts';

import {InMemoryWorkflowStore} from '../src/index.js';

const at = '2026-07-31T12:00:00.000Z';

const created: TaskSession = {
  id: 'task-001',
  createdAt: at,
  updatedAt: at,
  projectRoot: '/repo',
  frontendProvider: 'fixture-frontend',
  supervisorProvider: 'fixture-supervisor',
  workerProvider: 'fixture-worker',
  profileName: 'balanced',
  state: 'CREATED',
  iteration: 0,
};

describe('InMemoryWorkflowStore', () => {
  test('records a state change and event as one observable operation', async () => {
    const store = new InMemoryWorkflowStore();
    await store.createSession(created);
    const next = {...created, state: 'DISCOVERING_REPOSITORY' as const};
    const event: WorkflowEventRecord = {
      id: 'event-001',
      sessionId: created.id,
      timestamp: at,
      previousState: 'CREATED',
      nextState: 'DISCOVERING_REPOSITORY',
      event: {type: 'SESSION_STARTED'},
    };

    await store.commitTransition(created, next, event);

    await expect(store.getSession(created.id)).resolves.toEqual(next);
    await expect(store.listEvents(created.id)).resolves.toEqual([event]);
  });

  test('rejects a stale transition without writing either side', async () => {
    const store = new InMemoryWorkflowStore();
    await store.createSession(created);
    const stalePrevious = {...created, state: 'REQUIREMENT_DISCOVERY' as const};
    const next = {...created, state: 'DRAFTING_PLAN' as const};
    const event: WorkflowEventRecord = {
      id: 'event-001',
      sessionId: created.id,
      timestamp: at,
      previousState: 'REQUIREMENT_DISCOVERY',
      nextState: 'DRAFTING_PLAN',
      event: {type: 'REQUIREMENTS_SUFFICIENT'},
    };

    await expect(store.commitTransition(stalePrevious, next, event)).rejects.toThrow(/stale/iu);
    await expect(store.getSession(created.id)).resolves.toEqual(created);
    await expect(store.listEvents(created.id)).resolves.toEqual([]);
  });

  test('uses the authoritative workspace record in a resumed session', async () => {
    const store = new InMemoryWorkflowStore();
    const ready: ExecutionWorkspace = {
      id: created.id,
      path: '/worktree',
      mode: 'worktree',
      status: 'READY',
      createdAt: at,
    };
    await store.createSession({...created, workspace: ready});
    await store.recordWorkspace(created.id, {...ready, status: 'APPLIED'});

    const snapshot = await store.loadResumeSnapshot(created.id);

    expect(snapshot?.workspace?.status).toBe('APPLIED');
    expect(snapshot?.session.workspace?.status).toBe('APPLIED');
  });
});
