import {describe, expect, test} from 'vitest';

import type {TaskSession, WorkflowEvent, WorkflowState} from '@agent-foreman/contracts';

import {InvalidStateTransitionError, transitionWorkflow} from '../src/index.js';

const at = '2026-07-31T12:00:00.000Z';

const sessionIn = (state: WorkflowState): TaskSession => ({
  id: 'task-001',
  createdAt: at,
  updatedAt: at,
  projectRoot: '/repo',
  frontendProvider: 'fixture-frontend',
  supervisorProvider: 'fixture-supervisor',
  workerProvider: 'fixture-worker',
  profileName: 'balanced',
  state,
  iteration: 0,
});

describe('transitionWorkflow', () => {
  test('drives the approved happy path only through declared events', () => {
    const events: WorkflowEvent[] = [
      {type: 'SESSION_STARTED'},
      {type: 'REPOSITORY_DISCOVERED'},
      {type: 'REQUIREMENTS_SUFFICIENT'},
      {type: 'PLAN_DRAFTED', planVersion: 1},
      {type: 'PLAN_CHANGE_REQUESTED'},
      {type: 'PLAN_DRAFTED', planVersion: 2},
      {type: 'PLAN_APPROVED', planVersion: 2},
      {type: 'WORKSPACE_PREPARATION_STARTED'},
      {type: 'WORKSPACE_READY'},
      {type: 'WORKER_FINISHED'},
      {type: 'QUALITY_GATES_PASSED'},
      {type: 'SUPERVISOR_APPROVED'},
      {type: 'SUPERVISOR_APPROVED'},
      {type: 'APPLY_REVIEW_READY'},
      {type: 'APPLY_APPROVED'},
      {type: 'CHANGES_APPLIED'},
    ];
    const expected: WorkflowState[] = [
      'DISCOVERING_REPOSITORY',
      'REQUIREMENT_DISCOVERY',
      'DRAFTING_PLAN',
      'AWAITING_PLAN_REVIEW',
      'REVISING_PLAN',
      'AWAITING_PLAN_REVIEW',
      'PLAN_APPROVED',
      'PREPARING_WORKSPACE',
      'EXECUTING_WORKER',
      'RUNNING_QUALITY_GATES',
      'SUPERVISOR_REVIEW',
      'FINAL_REVIEW',
      'TECHNICALLY_APPROVED',
      'AWAITING_APPLY_APPROVAL',
      'APPLYING_CHANGES',
      'COMPLETED',
    ];

    let session = sessionIn('CREATED');
    for (const [index, event] of events.entries()) {
      session = transitionWorkflow(session, event, at);
      expect(session.state).toBe(expected[index]);
    }

    expect(session.currentPlanVersion).toBe(2);
    expect(session.approvedPlanVersion).toBe(2);
    expect(session.iteration).toBe(1);
  });

  test('rejects workspace preparation before explicit plan approval', () => {
    const session: TaskSession = {...sessionIn('AWAITING_PLAN_REVIEW'), currentPlanVersion: 1};

    expect(() => transitionWorkflow(session, {type: 'WORKSPACE_PREPARATION_STARTED'}, at)).toThrow(
      InvalidStateTransitionError,
    );
  });

  test('rejects approval of a plan version other than the reviewed version', () => {
    const session: TaskSession = {...sessionIn('AWAITING_PLAN_REVIEW'), currentPlanVersion: 2};

    expect(() => transitionWorkflow(session, {type: 'PLAN_APPROVED', planVersion: 1}, at)).toThrow(
      /current plan version 2/iu,
    );
  });

  test('routes mechanical failures back to repair without supervisor review', () => {
    const failed = transitionWorkflow(
      sessionIn('RUNNING_QUALITY_GATES'),
      {type: 'QUALITY_GATES_FAILED'},
      at,
    );
    expect(failed.state).toBe('REPAIRING_MECHANICAL_FAILURES');

    const rerun = transitionWorkflow(failed, {type: 'MECHANICAL_REPAIR_FINISHED'}, at);
    expect(rerun.state).toBe('RUNNING_QUALITY_GATES');
    expect(rerun.iteration).toBe(1);
  });

  test('stores the real execution workspace on the workspace-ready event', () => {
    const workspace = {
      id: 'workspace-001',
      path: '/tmp/worktree',
      mode: 'worktree' as const,
      status: 'READY' as const,
      createdAt: at,
    };
    const ready = transitionWorkflow(
      sessionIn('PREPARING_WORKSPACE'),
      {type: 'WORKSPACE_READY', workspace},
      at,
    );

    expect(ready.workspace).toEqual(workspace);
  });

  test('stores the applied workspace on the changes-applied event', () => {
    const workspace = {
      id: 'workspace-001',
      path: '/tmp/worktree',
      mode: 'worktree' as const,
      status: 'APPLIED' as const,
      createdAt: at,
    };
    const completed = transitionWorkflow(
      sessionIn('APPLYING_CHANGES'),
      {type: 'CHANGES_APPLIED', workspace},
      at,
    );

    expect(completed).toMatchObject({state: 'COMPLETED', workspace});
  });

  test('pauses and resumes only to the explicit saved state', () => {
    const paused = transitionWorkflow(
      sessionIn('SUPERVISOR_REVIEW'),
      {type: 'TASK_PAUSED', reason: 'User interrupted'},
      at,
    );
    expect(paused).toMatchObject({state: 'PAUSED', statusMessage: 'User interrupted'});

    const resumed = transitionWorkflow(
      paused,
      {type: 'TASK_RESUMED', resumeState: 'SUPERVISOR_REVIEW'},
      at,
    );
    expect(resumed).toMatchObject({state: 'SUPERVISOR_REVIEW'});
    expect(resumed.statusMessage).toBeUndefined();
  });

  test('starts a failed worker retry as a new auditable iteration', () => {
    const paused = {
      ...sessionIn('PAUSED'),
      iteration: 1,
      statusMessage: 'Worker execution failed.',
    };

    const retried = transitionWorkflow(paused, {type: 'WORKER_RETRY_STARTED'}, at);

    expect(retried).toMatchObject({state: 'EXECUTING_WORKER', iteration: 2});
    expect(retried.statusMessage).toBeUndefined();
    expect(() =>
      transitionWorkflow(sessionIn('PLAN_APPROVED'), {type: 'WORKER_RETRY_STARTED'}, at),
    ).toThrow(InvalidStateTransitionError);
  });
});
