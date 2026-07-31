import {createHash} from 'node:crypto';

import {TaskPlanSchema, type TaskPlan, type TaskSession} from '@agent-foreman/contracts';

import {PlanHashMismatchError, PlanNotApprovedError} from '../errors/index.js';

export interface ApprovedPlanRecord {
  readonly hash: string;
  readonly plan: TaskPlan;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

const canonicalPlanJson = (plan: TaskPlan): string => JSON.stringify(canonicalize(plan));

const planHash = (plan: TaskPlan): string =>
  createHash('sha256').update(canonicalPlanJson(plan), 'utf8').digest('hex');

const deepFreeze = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  Object.freeze(value);
};

export const approvePlan = (rawPlan: TaskPlan, approvedAt: string): ApprovedPlanRecord => {
  const draft = TaskPlanSchema.parse(rawPlan);
  if (draft.status !== 'DRAFT') {
    throw new PlanNotApprovedError('Only a draft plan can receive a new explicit approval.');
  }
  const approved = TaskPlanSchema.parse({...draft, status: 'APPROVED', approvedAt});
  const hash = planHash(approved);
  deepFreeze(approved);
  return {hash, plan: approved};
};

export const assertWorkerMayStart = (
  session: TaskSession,
  rawPlan: TaskPlan,
  expectedHash: string,
): void => {
  const plan = TaskPlanSchema.parse(rawPlan);
  if (plan.status !== 'APPROVED' || plan.approvedAt === undefined) {
    throw new PlanNotApprovedError('Worker execution requires an explicitly approved frozen plan.');
  }
  if (
    session.approvedPlanVersion !== plan.version ||
    session.currentPlanVersion !== plan.version ||
    session.id !== plan.taskId
  ) {
    throw new PlanNotApprovedError(
      'The approved plan does not match the active task and plan version.',
      {
        diagnostics: {
          approvedPlanVersion: session.approvedPlanVersion,
          currentPlanVersion: session.currentPlanVersion,
          planVersion: plan.version,
        },
      },
    );
  }
  const actualHash = planHash(plan);
  if (actualHash !== expectedHash) {
    throw new PlanHashMismatchError('Approved plan content does not match its frozen hash.', {
      diagnostics: {actualHash, expectedHash},
    });
  }
};

export const hashTaskPlan = (rawPlan: TaskPlan): string => planHash(TaskPlanSchema.parse(rawPlan));
