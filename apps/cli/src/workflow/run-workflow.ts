import {
  TaskPlanSchema,
  type QualityGateReport,
  type ReviewDecision,
  type TaskPlan,
  type TaskSession,
  type WorkflowEvent,
  type WorkflowEventRecord,
} from '@agent-foreman/contracts';
import {
  ProviderOutputValidationError,
  approvePlan,
  assertWorkerMayStart,
  transitionWorkflow,
} from '@agent-foreman/core';
import type {WorkflowStore} from '@agent-foreman/persistence';
import type {
  ProviderExecutionContext,
  SupervisorProvider,
  WorkerProvider,
} from '@agent-foreman/provider-sdk';

import type {PlanInputDecision} from './plan-input.js';
import {renderTaskPlanMarkdown} from './render-plan.js';

export interface WorkflowInteraction {
  reviewPlan(plan: TaskPlan): Promise<PlanInputDecision>;
  approveApply(session: TaskSession): Promise<boolean>;
}

export interface RunWorkflowOptions {
  readonly session: TaskSession;
  readonly userRequest: string;
  readonly supervisor: SupervisorProvider;
  readonly worker: WorkerProvider;
  readonly providerContext: ProviderExecutionContext;
  readonly store: WorkflowStore;
  readonly interaction: WorkflowInteraction;
  readonly prepareWorkspace: (session: TaskSession) => Promise<string>;
  readonly runQualityGates: (workspacePath: string) => Promise<QualityGateReport>;
  readonly applyChanges: (workspacePath: string) => Promise<void>;
  readonly now: () => string;
  readonly nextId: () => string;
}

const validateDraft = (rawPlan: TaskPlan, taskId: string, expectedVersion: number): TaskPlan => {
  const plan = TaskPlanSchema.parse(rawPlan);
  if (plan.taskId !== taskId || plan.version !== expectedVersion || plan.status !== 'DRAFT') {
    throw new ProviderOutputValidationError(
      'Supervisor returned a plan for the wrong task or version.',
      {
        diagnostics: {
          expectedTaskId: taskId,
          expectedVersion,
          receivedTaskId: plan.taskId,
          receivedVersion: plan.version,
          receivedStatus: plan.status,
        },
      },
    );
  }
  return plan;
};

export const runWorkflow = async (options: RunWorkflowOptions): Promise<TaskSession> => {
  let current = options.session;
  await options.store.createSession(current);

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
  };

  await commit({type: 'SESSION_STARTED'});
  await commit({type: 'REPOSITORY_DISCOVERED'});
  const discovery = await options.supervisor.analyzeRequirements(
    {userRequest: options.userRequest, conversation: []},
    options.providerContext,
  );
  if (!discovery.sufficient) {
    await commit({type: 'TASK_PAUSED', reason: 'Requirement discovery needs user input.'});
    return current;
  }

  await commit({type: 'REQUIREMENTS_SUFFICIENT'});
  let version = 1;
  let draft = validateDraft(
    await options.supervisor.draftPlan(
      {
        taskId: current.id,
        version,
        createdAt: options.now(),
        userRequest: options.userRequest,
        discovery,
      },
      options.providerContext,
    ),
    current.id,
    version,
  );
  await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
  await commit({type: 'PLAN_DRAFTED', planVersion: version});

  let approved: ReturnType<typeof approvePlan> | undefined;
  while (approved === undefined) {
    const decision = await options.interaction.reviewPlan(draft);
    if (decision.kind === 'cancel') {
      await commit({type: 'TASK_CANCELLED'});
      return current;
    }
    if (decision.kind === 'request-change') {
      await commit({type: 'PLAN_CHANGE_REQUESTED'});
      version += 1;
      draft = validateDraft(
        await options.supervisor.revisePlan(
          {currentPlan: draft, changeRequest: decision.message, version, createdAt: options.now()},
          options.providerContext,
        ),
        current.id,
        version,
      );
      await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
      await commit({type: 'PLAN_DRAFTED', planVersion: version});
      continue;
    }
    if (decision.kind === 'approve') {
      approved = approvePlan(draft, options.now());
      await options.store.savePlan(
        approved.plan,
        renderTaskPlanMarkdown(approved.plan),
        approved.hash,
      );
      await commit({type: 'PLAN_APPROVED', planVersion: approved.plan.version});
    }
  }

  await commit({type: 'WORKSPACE_PREPARATION_STARTED'});
  const workspacePath = await options.prepareWorkspace(current);
  await commit({type: 'WORKSPACE_READY'});
  assertWorkerMayStart(current, approved.plan, approved.hash);

  const emptyGateReport: QualityGateReport = {
    status: 'PASSED',
    failures: [],
    startedAt: options.now(),
    completedAt: options.now(),
  };
  const workerContext: ProviderExecutionContext = {
    ...options.providerContext,
    permissions: {
      filesystem: 'workspace-write',
      shell: 'project-scoped',
      network: 'ask',
      workerLaunch: 'denied',
    },
  };
  const workerResult = await options.worker.execute(
    {
      approvedPlan: approved.plan,
      approvedPlanHash: approved.hash,
      projectSummary: {
        root: current.projectRoot,
        vcs: 'git',
        languages: [],
        packageManagers: [],
        relevantFiles: [],
        summary: 'Repository summary is supplied by the application discovery adapter.',
      },
      workspacePath,
      constraints: {
        allowedAreas: approved.plan.expectedFileAreas,
        deniedAreas: ['.git'],
        networkAccess: 'ask',
        destructiveCommands: 'denied',
      },
      baselineResults: emptyGateReport,
      outputSchema: {schemaVersion: 1},
    },
    workerContext,
  );
  await commit({type: 'WORKER_FINISHED'});

  const gates = await options.runQualityGates(workspacePath);
  if (gates.status !== 'PASSED') {
    await commit({type: 'QUALITY_GATES_FAILED'});
    await commit({type: 'TASK_PAUSED', reason: 'Mechanical repair is required.'});
    return current;
  }
  await commit({type: 'QUALITY_GATES_PASSED'});

  const reviewInput = {
    approvedPlan: approved.plan,
    approvedPlanHash: approved.hash,
    workerResult,
    qualityGateReport: gates,
    relevantDiff: '',
  };
  const review: ReviewDecision = await options.supervisor.reviewImplementation(
    reviewInput,
    options.providerContext,
  );
  if (review.verdict !== 'APPROVED') {
    await commit({type: 'TASK_PAUSED', reason: 'Supervisor requested implementation revision.'});
    return current;
  }
  await commit({type: 'SUPERVISOR_APPROVED'});

  const finalReview = await options.supervisor.finalReview(
    {...reviewInput, reviewDecision: review},
    options.providerContext,
  );
  if (finalReview.verdict !== 'APPROVED') {
    await commit({type: 'TASK_PAUSED', reason: 'Final review did not approve the implementation.'});
    return current;
  }
  await commit({type: 'SUPERVISOR_APPROVED'});
  await commit({type: 'APPLY_REVIEW_READY'});

  if (!(await options.interaction.approveApply(current))) return current;
  await commit({type: 'APPLY_APPROVED'});
  await options.applyChanges(workspacePath);
  await commit({type: 'CHANGES_APPLIED'});
  return current;
};
