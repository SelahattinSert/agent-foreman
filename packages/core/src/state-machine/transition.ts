import {
  TaskSessionSchema,
  WorkflowEventSchema,
  type TaskSession,
  type WorkflowEvent,
  type WorkflowState,
} from '@agent-foreman/contracts';

import {InvalidStateTransitionError} from '../errors/index.js';

const terminalStates = new Set<WorkflowState>(['COMPLETED', 'FAILED', 'CANCELLED']);

const requireState = (
  current: WorkflowState,
  allowed: readonly WorkflowState[],
  event: WorkflowEvent,
  next: WorkflowState,
): WorkflowState => {
  if (!allowed.includes(current)) {
    throw new InvalidStateTransitionError(current, event.type);
  }
  return next;
};

const nextStateFor = (current: WorkflowState, event: WorkflowEvent): WorkflowState => {
  if (event.type === 'TASK_CANCELLED') {
    if (terminalStates.has(current)) throw new InvalidStateTransitionError(current, event.type);
    return 'CANCELLED';
  }
  if (event.type === 'FATAL_ERROR') {
    if (terminalStates.has(current)) throw new InvalidStateTransitionError(current, event.type);
    return 'FAILED';
  }
  if (event.type === 'TASK_PAUSED') {
    if (terminalStates.has(current) || current === 'PAUSED') {
      throw new InvalidStateTransitionError(current, event.type);
    }
    return 'PAUSED';
  }
  if (event.type === 'TASK_RESUMED') {
    if (
      current !== 'PAUSED' ||
      terminalStates.has(event.resumeState) ||
      event.resumeState === 'PAUSED'
    ) {
      throw new InvalidStateTransitionError(current, event.type);
    }
    return event.resumeState;
  }

  switch (event.type) {
    case 'SESSION_STARTED':
      return requireState(current, ['CREATED'], event, 'DISCOVERING_REPOSITORY');
    case 'REPOSITORY_DISCOVERED':
      return requireState(current, ['DISCOVERING_REPOSITORY'], event, 'REQUIREMENT_DISCOVERY');
    case 'REQUIREMENTS_SUFFICIENT':
      return requireState(current, ['REQUIREMENT_DISCOVERY'], event, 'DRAFTING_PLAN');
    case 'PLAN_DRAFTED':
      return requireState(
        current,
        ['DRAFTING_PLAN', 'REVISING_PLAN'],
        event,
        'AWAITING_PLAN_REVIEW',
      );
    case 'PLAN_CHANGE_REQUESTED':
      return requireState(current, ['AWAITING_PLAN_REVIEW'], event, 'REVISING_PLAN');
    case 'PLAN_APPROVED':
      return requireState(current, ['AWAITING_PLAN_REVIEW'], event, 'PLAN_APPROVED');
    case 'WORKSPACE_PREPARATION_STARTED':
      return requireState(current, ['PLAN_APPROVED'], event, 'PREPARING_WORKSPACE');
    case 'WORKSPACE_READY':
      return requireState(current, ['PREPARING_WORKSPACE'], event, 'EXECUTING_WORKER');
    case 'WORKER_FINISHED':
      return requireState(current, ['EXECUTING_WORKER'], event, 'RUNNING_QUALITY_GATES');
    case 'QUALITY_GATES_PASSED':
      return requireState(current, ['RUNNING_QUALITY_GATES'], event, 'SUPERVISOR_REVIEW');
    case 'QUALITY_GATES_FAILED':
      return requireState(
        current,
        ['RUNNING_QUALITY_GATES'],
        event,
        'REPAIRING_MECHANICAL_FAILURES',
      );
    case 'MECHANICAL_REPAIR_FINISHED':
      return requireState(
        current,
        ['REPAIRING_MECHANICAL_FAILURES'],
        event,
        'RUNNING_QUALITY_GATES',
      );
    case 'SUPERVISOR_APPROVED':
      if (current === 'SUPERVISOR_REVIEW') return 'FINAL_REVIEW';
      return requireState(current, ['FINAL_REVIEW'], event, 'TECHNICALLY_APPROVED');
    case 'SUPERVISOR_REQUESTED_REVISION':
      return requireState(
        current,
        ['SUPERVISOR_REVIEW', 'FINAL_REVIEW'],
        event,
        'REVISING_IMPLEMENTATION',
      );
    case 'WORKER_REVISION_STARTED':
      return requireState(current, ['REVISING_IMPLEMENTATION'], event, 'EXECUTING_WORKER');
    case 'USER_DECISION_REQUIRED':
      return requireState(
        current,
        ['EXECUTING_WORKER', 'SUPERVISOR_REVIEW', 'FINAL_REVIEW', 'REVISING_IMPLEMENTATION'],
        event,
        'AWAITING_USER_DECISION',
      );
    case 'USER_DECISION_RECEIVED':
      return requireState(current, ['AWAITING_USER_DECISION'], event, 'REVISING_IMPLEMENTATION');
    case 'APPLY_REVIEW_READY':
      return requireState(current, ['TECHNICALLY_APPROVED'], event, 'AWAITING_APPLY_APPROVAL');
    case 'APPLY_APPROVED':
      return requireState(current, ['AWAITING_APPLY_APPROVAL'], event, 'APPLYING_CHANGES');
    case 'CHANGES_APPLIED':
      return requireState(current, ['APPLYING_CHANGES'], event, 'COMPLETED');
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

export const transitionWorkflow = (
  rawSession: TaskSession,
  rawEvent: WorkflowEvent,
  timestamp: string,
): TaskSession => {
  const session = TaskSessionSchema.parse(rawSession);
  const event = WorkflowEventSchema.parse(rawEvent);

  if (event.type === 'PLAN_APPROVED' && event.planVersion !== session.currentPlanVersion) {
    throw new InvalidStateTransitionError(
      session.state,
      event.type,
      `Cannot approve plan version ${String(event.planVersion)}; current plan version ${String(session.currentPlanVersion)} is awaiting review.`,
    );
  }

  const nextState = nextStateFor(session.state, event);
  const next: TaskSession = {...session, state: nextState, updatedAt: timestamp};

  if (event.type === 'PLAN_DRAFTED') next.currentPlanVersion = event.planVersion;
  if (event.type === 'PLAN_APPROVED') next.approvedPlanVersion = event.planVersion;
  if (
    event.type === 'WORKSPACE_READY' ||
    event.type === 'WORKER_REVISION_STARTED' ||
    event.type === 'MECHANICAL_REPAIR_FINISHED'
  ) {
    next.iteration += 1;
  }
  if (event.type === 'WORKSPACE_READY' && event.workspace !== undefined) {
    next.workspace = event.workspace;
  }
  if (event.type === 'TASK_PAUSED' || event.type === 'FATAL_ERROR') {
    next.statusMessage = event.reason;
  }
  if (event.type === 'TASK_RESUMED') delete next.statusMessage;

  return TaskSessionSchema.parse(next);
};
