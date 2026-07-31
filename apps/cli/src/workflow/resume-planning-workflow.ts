import {createHash} from 'node:crypto';

import {
  TaskPlanSchema,
  type ProjectSummary,
  type TaskPlan,
  type TaskSession,
  type WorkflowEvent,
  type WorkflowEventRecord,
} from '@agent-foreman/contracts';
import {
  ConfigurationError,
  approvePlan,
  transitionWorkflow,
  type ReviewApprovalPolicy,
} from '@agent-foreman/core';
import type {ResumeSnapshot} from '@agent-foreman/persistence';
import type {
  ProviderExecutionContext,
  SupervisorProvider,
  WorkerProvider,
} from '@agent-foreman/provider-sdk';
import type {QualityGateReport, ExecutionWorkspace} from '@agent-foreman/contracts';
import type {WorkspaceDiff} from '@agent-foreman/workspace';

import {renderTaskPlanMarkdown} from './render-plan.js';
import {resumeExecutionWorkflow} from './resume-execution-workflow.js';
import type {RealWorkflowInteraction, RealWorkflowStore} from './run-real-workflow.js';
import type {WorkflowLoopLimits} from '@agent-foreman/core';

export interface ResumePlanningWorkflowOptions {
  readonly snapshot: ResumeSnapshot;
  readonly projectSummary: ProjectSummary;
  readonly supervisor: SupervisorProvider;
  readonly worker: WorkerProvider;
  readonly supervisorContext: ProviderExecutionContext;
  readonly store: RealWorkflowStore;
  readonly interaction: RealWorkflowInteraction;
  readonly prepareWorkspace: (session: TaskSession) => Promise<ExecutionWorkspace>;
  readonly collectDiff: (workspace: ExecutionWorkspace) => Promise<WorkspaceDiff>;
  readonly runQualityGates: (workspacePath: string) => Promise<QualityGateReport>;
  readonly applyChanges: (
    workspace: ExecutionWorkspace,
  ) => Promise<{readonly workspace: ExecutionWorkspace}>;
  readonly discardWorkspace: (workspace: ExecutionWorkspace) => Promise<ExecutionWorkspace>;
  readonly limits: WorkflowLoopLimits;
  readonly reviewPolicy: ReviewApprovalPolicy;
  readonly now: () => string;
  readonly nextId: () => string;
}

const hashValue = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const validateDraft = (plan: TaskPlan, taskId: string, version: number): TaskPlan => {
  const parsed = TaskPlanSchema.parse(plan);
  if (parsed.taskId !== taskId || parsed.version !== version || parsed.status !== 'DRAFT') {
    throw new ConfigurationError(
      'Resumed supervisor plan has an invalid task, version, or status.',
    );
  }
  return parsed;
};

export const resumePlanningWorkflow = async (
  options: ResumePlanningWorkflowOptions,
): Promise<TaskSession> => {
  let current = options.snapshot.session;
  const userRequest = current.userRequest;
  if (userRequest === undefined) {
    throw new ConfigurationError(
      'This persisted task predates user-request recovery metadata and cannot safely resume planning.',
    );
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
  const callSupervisor = async <T>(
    operation: string,
    request: unknown,
    invoke: () => Promise<T>,
  ): Promise<T> => {
    const descriptor = await options.supervisor.descriptor();
    const executionId = options.nextId();
    const startedAt = options.now();
    await options.store.recordProviderExecution({
      id: executionId,
      sessionId: current.id,
      role: 'supervisor',
      providerId: descriptor.id,
      ...(current.supervisorModel === undefined ? {} : {model: current.supervisorModel}),
      status: 'STARTED',
      startedAt,
      requestHash: hashValue({operation, request}),
    });
    const result = await invoke();
    await options.store.recordProviderExecution({
      id: executionId,
      sessionId: current.id,
      role: 'supervisor',
      providerId: descriptor.id,
      ...(current.supervisorModel === undefined ? {} : {model: current.supervisorModel}),
      status: 'COMPLETED',
      startedAt,
      completedAt: options.now(),
      requestHash: hashValue({operation, request}),
      result,
    });
    return result;
  };

  if (current.state === 'PAUSED') {
    const pause = [...options.snapshot.events]
      .reverse()
      .find(({event}) => event.type === 'TASK_PAUSED');
    if (pause === undefined) throw new ConfigurationError('Paused task has no recovery event.');
    await commit({type: 'TASK_RESUMED', resumeState: pause.previousState});
  }
  if (current.state === 'CREATED') await commit({type: 'SESSION_STARTED'});
  if (current.state === 'DISCOVERING_REPOSITORY') await commit({type: 'REPOSITORY_DISCOVERED'});

  if (current.state === 'REQUIREMENT_DISCOVERY') {
    const conversation: {role: 'user' | 'supervisor'; content: string}[] = [];
    let discovery = await callSupervisor(
      'analyzeRequirements.resume',
      {userRequest, projectSummary: options.projectSummary},
      async () =>
        await options.supervisor.analyzeRequirements(
          {userRequest, conversation, projectSummary: options.projectSummary},
          options.supervisorContext,
        ),
    );
    while (!discovery.sufficient) {
      const answer = await options.interaction.answerRequirements(discovery);
      if (answer === undefined) {
        await commit({type: 'TASK_PAUSED', reason: 'Requirement discussion remains incomplete.'});
        return current;
      }
      conversation.push({role: 'supervisor', content: discovery.questions.join('\n')});
      conversation.push({role: 'user', content: answer});
      discovery = await callSupervisor(
        'analyzeRequirements.resume',
        {userRequest, conversation, projectSummary: options.projectSummary},
        async () =>
          await options.supervisor.analyzeRequirements(
            {userRequest, conversation, projectSummary: options.projectSummary},
            options.supervisorContext,
          ),
      );
    }
    await commit({type: 'REQUIREMENTS_SUFFICIENT'});
    const version = (current.currentPlanVersion ?? 0) + 1;
    const draft = validateDraft(
      await callSupervisor(
        'draftPlan.resume',
        {taskId: current.id, version, userRequest, discovery},
        async () =>
          await options.supervisor.draftPlan(
            {taskId: current.id, version, createdAt: options.now(), userRequest, discovery},
            options.supervisorContext,
          ),
      ),
      current.id,
      version,
    );
    await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
    await commit({type: 'PLAN_DRAFTED', planVersion: version});
  }

  if (current.state === 'DRAFTING_PLAN') {
    const discovery = {
      summary: userRequest,
      repositoryObservations: [options.projectSummary.summary],
      questions: [],
      proposedAssumptions: [],
      sufficient: true,
    };
    const version = (current.currentPlanVersion ?? 0) + 1;
    const draft = validateDraft(
      await callSupervisor(
        'draftPlan.resume',
        {taskId: current.id, version},
        async () =>
          await options.supervisor.draftPlan(
            {taskId: current.id, version, createdAt: options.now(), userRequest, discovery},
            options.supervisorContext,
          ),
      ),
      current.id,
      version,
    );
    await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
    await commit({type: 'PLAN_DRAFTED', planVersion: version});
  }

  let draft =
    current.currentPlanVersion === undefined
      ? undefined
      : await options.store.getPlan(current.id, current.currentPlanVersion);
  if (current.state === 'REVISING_PLAN') {
    if (draft === undefined)
      throw new ConfigurationError('Plan revision state has no persisted draft.');
    const decision = await options.interaction.reviewPlan(draft);
    if (decision.kind === 'cancel') {
      await commit({type: 'TASK_CANCELLED'});
      return current;
    }
    const changeRequest =
      decision.kind === 'request-change'
        ? decision.message
        : 'Resume the interrupted plan revision and revalidate the current draft.';
    const version = draft.version + 1;
    const priorDraft = draft;
    draft = validateDraft(
      await callSupervisor(
        'revisePlan.resume',
        {currentPlan: priorDraft, changeRequest, version},
        async () =>
          await options.supervisor.revisePlan(
            {currentPlan: priorDraft, changeRequest, version, createdAt: options.now()},
            options.supervisorContext,
          ),
      ),
      current.id,
      version,
    );
    await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
    await commit({type: 'PLAN_DRAFTED', planVersion: version});
  }

  while (current.state === 'AWAITING_PLAN_REVIEW') {
    draft ??=
      current.currentPlanVersion === undefined
        ? undefined
        : await options.store.getPlan(current.id, current.currentPlanVersion);
    if (draft === undefined)
      throw new ConfigurationError('Plan review state has no persisted draft.');
    const decision = await options.interaction.reviewPlan(draft);
    await options.store.recordUserDecision({
      id: options.nextId(),
      sessionId: current.id,
      kind: 'PLAN_REVIEW_RESUME',
      decision,
      createdAt: options.now(),
    });
    if (decision.kind === 'cancel') {
      await commit({type: 'TASK_CANCELLED'});
      return current;
    }
    if (decision.kind === 'request-change') {
      await commit({type: 'PLAN_CHANGE_REQUESTED'});
      await options.store.savePlan(
        TaskPlanSchema.parse({...draft, status: 'SUPERSEDED'}),
        renderTaskPlanMarkdown({...draft, status: 'SUPERSEDED'}),
      );
      const version = draft.version + 1;
      const priorDraft = draft;
      draft = validateDraft(
        await callSupervisor(
          'revisePlan.resume',
          {currentPlan: priorDraft, decision, version},
          async () =>
            await options.supervisor.revisePlan(
              {
                currentPlan: priorDraft,
                changeRequest: decision.message,
                version,
                createdAt: options.now(),
              },
              options.supervisorContext,
            ),
        ),
        current.id,
        version,
      );
      await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
      await commit({type: 'PLAN_DRAFTED', planVersion: version});
      continue;
    }
    if (decision.kind !== 'approve') continue;
    const approved = approvePlan(draft, options.now());
    const approvedAt = approved.plan.approvedAt;
    if (approvedAt === undefined) throw new ConfigurationError('Approved plan has no timestamp.');
    await options.store.savePlan(
      approved.plan,
      renderTaskPlanMarkdown(approved.plan),
      approved.hash,
    );
    await options.store.savePlanApproval({
      taskId: current.id,
      planVersion: approved.plan.version,
      hash: approved.hash,
      approvedAt,
    });
    await commit({type: 'PLAN_APPROVED', planVersion: approved.plan.version});
  }

  if (current.state === 'PLAN_APPROVED') await commit({type: 'WORKSPACE_PREPARATION_STARTED'});
  if (current.state === 'PREPARING_WORKSPACE') {
    const workspace = options.snapshot.workspace ?? (await options.prepareWorkspace(current));
    await options.store.recordWorkspace(current.id, workspace);
    await commit({type: 'WORKSPACE_READY', workspace});
  }
  const executionSnapshot = await options.store.loadResumeSnapshot(current.id);
  if (executionSnapshot === undefined)
    throw new ConfigurationError('Could not reload resumed task.');
  return await resumeExecutionWorkflow({...options, snapshot: executionSnapshot});
};
