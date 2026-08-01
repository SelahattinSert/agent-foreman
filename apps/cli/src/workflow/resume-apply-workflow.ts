import type {
  ExecutionWorkspace,
  TaskSession,
  WorkflowEvent,
  WorkflowEventRecord,
} from '@agent-foreman/contracts';
import {ConfigurationError, transitionWorkflow} from '@agent-foreman/core';
import type {ResumeSnapshot} from '@agent-foreman/persistence';
import type {WorkspaceDiff} from '@agent-foreman/workspace';

import type {RealWorkflowInteraction, RealWorkflowStore} from './run-real-workflow.js';

export interface ResumeApplyWorkflowOptions {
  readonly snapshot: ResumeSnapshot;
  readonly store: RealWorkflowStore;
  readonly interaction: RealWorkflowInteraction;
  readonly collectDiff: (workspace: ExecutionWorkspace) => Promise<WorkspaceDiff>;
  readonly applyChanges: (
    workspace: ExecutionWorkspace,
  ) => Promise<{readonly workspace: ExecutionWorkspace}>;
  readonly discardWorkspace: (workspace: ExecutionWorkspace) => Promise<ExecutionWorkspace>;
  readonly now: () => string;
  readonly nextId: () => string;
}

export const resumeApplyWorkflow = async (
  options: ResumeApplyWorkflowOptions,
): Promise<TaskSession> => {
  let current = options.snapshot.session;
  let workspace = options.snapshot.workspace;
  if (workspace === undefined) {
    throw new ConfigurationError('Persisted task has no execution workspace to resume.');
  }
  const commit = async (event: WorkflowEvent): Promise<void> => {
    const timestamp = options.now();
    const previous = current;
    const next = transitionWorkflow(previous, event, timestamp);
    const record: WorkflowEventRecord = {
      id: options.nextId(),
      sessionId: previous.id,
      timestamp,
      previousState: previous.state,
      nextState: next.state,
      event,
    };
    await options.store.commitTransition(previous, next, record);
    current = next;
    options.interaction.notify('state.changed', {previous: previous.state, next: next.state});
  };

  if (current.state === 'PAUSED') {
    const pauseEvent = [...options.snapshot.events]
      .reverse()
      .find(({event}) => event.type === 'TASK_PAUSED');
    if (
      pauseEvent?.previousState !== 'AWAITING_APPLY_APPROVAL' &&
      pauseEvent?.previousState !== 'APPLYING_CHANGES'
    ) {
      throw new ConfigurationError(
        `Task was paused from ${pauseEvent?.previousState ?? 'an unknown state'}, not apply review.`,
      );
    }
    await commit({type: 'TASK_RESUMED', resumeState: pauseEvent.previousState});
    if (pauseEvent.previousState === 'APPLYING_CHANGES') {
      const applied = await options.applyChanges(workspace);
      workspace = applied.workspace;
      await options.store.recordWorkspace(current.id, workspace);
      await commit({type: 'CHANGES_APPLIED', workspace});
      return current;
    }
  } else if (current.state === 'TECHNICALLY_APPROVED') {
    await commit({type: 'APPLY_REVIEW_READY'});
  } else if (current.state === 'APPLYING_CHANGES') {
    const applied = await options.applyChanges(workspace);
    workspace = applied.workspace;
    await options.store.recordWorkspace(current.id, workspace);
    await commit({type: 'CHANGES_APPLIED', workspace});
    return current;
  } else if (current.state !== 'AWAITING_APPLY_APPROVAL') {
    throw new ConfigurationError(
      `Task state ${current.state} is not at the apply approval boundary.`,
    );
  }

  const diff = await options.collectDiff(workspace);
  const decision = await options.interaction.reviewApply(current, diff);
  await options.store.recordUserDecision({
    id: options.nextId(),
    sessionId: current.id,
    kind: 'APPLY_REVIEW_RESUME',
    decision,
    createdAt: options.now(),
  });
  if (decision === 'keep' || decision === 'cancel') {
    workspace = {...workspace, status: 'PRESERVED'};
    await options.store.recordWorkspace(current.id, workspace);
    await commit({
      type: 'TASK_PAUSED',
      reason: 'Execution worktree was preserved without applying.',
    });
    return current;
  }
  if (decision === 'discard') {
    workspace = await options.discardWorkspace(workspace);
    await options.store.recordWorkspace(current.id, workspace);
    await commit({type: 'TASK_CANCELLED'});
    return current;
  }
  await commit({type: 'APPLY_APPROVED'});
  const applied = await options.applyChanges(workspace);
  workspace = applied.workspace;
  await options.store.recordWorkspace(current.id, workspace);
  await commit({type: 'CHANGES_APPLIED', workspace});
  return current;
};
