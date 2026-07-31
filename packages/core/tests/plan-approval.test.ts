import {describe, expect, test} from 'vitest';

import type {TaskPlan, TaskSession} from '@agent-foreman/contracts';

import {
  PlanHashMismatchError,
  PlanNotApprovedError,
  approvePlan,
  assertWorkerMayStart,
} from '../src/index.js';

const createdAt = '2026-07-31T12:00:00.000Z';

const draftPlan = (): TaskPlan => ({
  schemaVersion: 1,
  taskId: 'task-001',
  version: 1,
  status: 'DRAFT',
  title: 'Guard worker startup',
  objective: 'Require explicit plan approval.',
  userIntentSummary: 'Do not let a worker start early.',
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
});

const approvedSession = (): TaskSession => ({
  id: 'task-001',
  createdAt,
  updatedAt: createdAt,
  projectRoot: '/repo',
  frontendProvider: 'fixture-frontend',
  supervisorProvider: 'fixture-supervisor',
  workerProvider: 'fixture-worker',
  profileName: 'balanced',
  state: 'PLAN_APPROVED',
  currentPlanVersion: 1,
  approvedPlanVersion: 1,
  iteration: 0,
});

describe('plan approval', () => {
  test('freezes an approved plan and returns a reproducible SHA-256 hash', () => {
    const first = approvePlan(draftPlan(), createdAt);
    const second = approvePlan(draftPlan(), createdAt);

    expect(first.plan).toMatchObject({status: 'APPROVED', approvedAt: createdAt});
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.hash).toBe(first.hash);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(() => {
      first.plan.title = 'Mutated after approval';
    }).toThrow(TypeError);
  });

  test('rejects worker startup when the plan is not approved', () => {
    expect(() => {
      assertWorkerMayStart(approvedSession(), draftPlan(), 'invalid');
    }).toThrow(PlanNotApprovedError);
  });

  test('rejects worker startup when approved plan content does not match its hash', () => {
    const approved = approvePlan(draftPlan(), createdAt);
    const changed = structuredClone(approved.plan);
    changed.objective = 'Changed after user approval';

    expect(() => {
      assertWorkerMayStart(approvedSession(), changed, approved.hash);
    }).toThrow(PlanHashMismatchError);
  });

  test('allows worker startup only for the session approved version and exact hash', () => {
    const approved = approvePlan(draftPlan(), createdAt);

    expect(() => {
      assertWorkerMayStart(approvedSession(), approved.plan, approved.hash);
    }).not.toThrow();
  });
});
