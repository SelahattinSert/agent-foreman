import {createHash} from 'node:crypto';

import {
  TaskPlanSchema,
  type ExecutionWorkspace,
  type ProjectSummary,
  type QualityGateReport,
  type ReviewDecision,
  type ReviewFinding,
  type TaskPlan,
  type TaskSession,
  type WorkflowEvent,
  type WorkflowEventRecord,
  type WorkerExecutionResult,
  type WorkerRevisionInput,
} from '@agent-foreman/contracts';
import {
  LoopProtectionError,
  ProviderOutputValidationError,
  WorkflowLoopGuard,
  approvePlan,
  assertReviewMayApprove,
  assertWorkerMayStart,
  transitionWorkflow,
  validateFindingLifecycle,
  type WorkflowLoopLimits,
  type ReviewApprovalPolicy,
} from '@agent-foreman/core';
import type {
  RuntimeRecordRepository,
  WorkflowStore,
  WorkerIterationRecord,
} from '@agent-foreman/persistence';
import type {
  ProviderExecutionContext,
  SupervisorProvider,
  WorkerProvider,
} from '@agent-foreman/provider-sdk';
import type {WorkspaceDiff} from '@agent-foreman/workspace';
import {evaluateDiffPolicyGates} from '@agent-foreman/quality-gates';

import type {PlanInputDecision} from './plan-input.js';
import {renderTaskPlanMarkdown} from './render-plan.js';

export type ApplyReviewDecision = 'apply' | 'keep' | 'discard' | 'cancel';

export interface RealWorkflowInteraction {
  answerRequirements(
    discovery: Awaited<ReturnType<SupervisorProvider['analyzeRequirements']>>,
  ): Promise<string | undefined>;
  reviewPlan(plan: TaskPlan): Promise<PlanInputDecision>;
  reviewApply(session: TaskSession, diff: WorkspaceDiff): Promise<ApplyReviewDecision>;
  notify(event: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface RealWorkflowStore extends WorkflowStore, RuntimeRecordRepository {}

export interface RunRealWorkflowOptions {
  readonly session: TaskSession;
  readonly userRequest: string;
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
  readonly discardWorkspace?: (workspace: ExecutionWorkspace) => Promise<ExecutionWorkspace>;
  readonly limits: WorkflowLoopLimits;
  readonly reviewPolicy: ReviewApprovalPolicy;
  readonly now: () => string;
  readonly nextId: () => string;
}

const hashValue = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const validateDraft = (rawPlan: TaskPlan, taskId: string, expectedVersion: number): TaskPlan => {
  const plan = TaskPlanSchema.parse(rawPlan);
  if (plan.taskId !== taskId || plan.version !== expectedVersion || plan.status !== 'DRAFT') {
    throw new ProviderOutputValidationError(
      'Supervisor returned a plan for the wrong task, version, or status.',
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

const emptyGateReport = (now: () => string): QualityGateReport => {
  const timestamp = now();
  return {status: 'PASSED', failures: [], startedAt: timestamp, completedAt: timestamp, runs: []};
};

const mergeGateReports = (
  commandReport: QualityGateReport,
  policyReport: QualityGateReport,
): QualityGateReport => ({
  status:
    commandReport.status === 'CANCELLED'
      ? 'CANCELLED'
      : commandReport.status === 'FAILED' || policyReport.status === 'FAILED'
        ? 'FAILED'
        : 'PASSED',
  failures: [...commandReport.failures, ...policyReport.failures],
  startedAt: commandReport.startedAt,
  completedAt: policyReport.completedAt,
  runs: [...(commandReport.runs ?? []), ...(policyReport.runs ?? [])],
});

const blockingWorkerReason = (result: WorkerExecutionResult): string | undefined => {
  if (result.status === 'FAILED') return `Worker failed: ${result.summary}`;
  if (result.status !== 'BLOCKED' && result.blockers.length === 0) return undefined;
  return result.blockers.length === 0
    ? `Worker is blocked: ${result.summary}`
    : result.blockers.map((blocker) => `${blocker.type}: ${blocker.summary}`).join('\n');
};

export const runRealWorkflow = async (options: RunRealWorkflowOptions): Promise<TaskSession> => {
  let current = options.session;
  const loopGuard = new WorkflowLoopGuard(options.limits);
  let workspace: ExecutionWorkspace | undefined;
  let workerResult: WorkerExecutionResult | undefined;
  let currentDiff: WorkspaceDiff | undefined;
  let latestPassingGates: QualityGateReport | undefined;
  let openFindings: ReviewFinding[] = [];
  let previousDecision: ReviewDecision | undefined;

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
    try {
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
    } catch (error: unknown) {
      await options.store.recordProviderExecution({
        id: executionId,
        sessionId: current.id,
        role: 'supervisor',
        providerId: descriptor.id,
        ...(current.supervisorModel === undefined ? {} : {model: current.supervisorModel}),
        status: 'FAILED',
        startedAt,
        completedAt: options.now(),
        requestHash: hashValue({operation, request}),
        errorCode:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'AF_UNKNOWN',
      });
      throw error;
    }
  };

  const workerContext = (): ProviderExecutionContext => {
    if (workspace === undefined) throw new Error('Execution workspace is not prepared.');
    return {
      ...options.supervisorContext,
      executionWorkspace: workspace,
      permissions: {
        filesystem: 'workspace-write',
        shell: 'project-scoped',
        network: 'ask',
        workerLaunch: 'denied',
      },
    };
  };

  const callWorker = async (
    operation: 'INITIAL' | 'MECHANICAL_REPAIR' | 'REVISION',
    request: unknown,
    invoke: () => Promise<WorkerExecutionResult>,
  ): Promise<{
    readonly result: WorkerExecutionResult;
    readonly iterationId: string;
    readonly startedAt: string;
  }> => {
    loopGuard.recordWorkerIteration();
    const descriptor = await options.worker.descriptor();
    const executionId = options.nextId();
    const iterationId = options.nextId();
    const startedAt = options.now();
    const requestHash = hashValue({operation, request});
    await options.store.recordProviderExecution({
      id: executionId,
      sessionId: current.id,
      role: 'worker',
      providerId: descriptor.id,
      ...(current.workerModel === undefined ? {} : {model: current.workerModel}),
      status: 'STARTED',
      startedAt,
      requestHash,
    });
    await options.store.recordWorkerIteration({
      id: iterationId,
      sessionId: current.id,
      iteration: operation === 'MECHANICAL_REPAIR' ? current.iteration + 1 : current.iteration,
      kind: operation,
      startedAt,
    });
    try {
      const result = await invoke();
      const responseHash = hashValue(result);
      loopGuard.recordProviderResponse(responseHash);
      await options.store.recordProviderExecution({
        id: executionId,
        sessionId: current.id,
        role: 'worker',
        providerId: descriptor.id,
        ...(current.workerModel === undefined ? {} : {model: current.workerModel}),
        status: 'COMPLETED',
        startedAt,
        completedAt: options.now(),
        ...(result.providerSessionId === undefined
          ? {}
          : {providerSessionId: result.providerSessionId}),
        requestHash,
        result,
      });
      if (result.tokenUsage !== undefined) {
        await options.store.recordTokenUsage({
          id: options.nextId(),
          sessionId: current.id,
          providerExecutionId: executionId,
          role: 'worker',
          usage: result.tokenUsage,
          createdAt: options.now(),
        });
      }
      return {result, iterationId, startedAt};
    } catch (error: unknown) {
      await options.store.recordProviderExecution({
        id: executionId,
        sessionId: current.id,
        role: 'worker',
        providerId: descriptor.id,
        ...(current.workerModel === undefined ? {} : {model: current.workerModel}),
        status: 'FAILED',
        startedAt,
        completedAt: options.now(),
        requestHash,
        errorCode:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'AF_UNKNOWN',
      });
      throw error;
    }
  };

  const recordWorkerCompletion = async (
    call: Awaited<ReturnType<typeof callWorker>>,
    kind: WorkerIterationRecord['kind'],
  ): Promise<void> => {
    if (workspace === undefined) throw new Error('Execution workspace is not prepared.');
    currentDiff = await options.collectDiff(workspace);
    loopGuard.recordDiff(currentDiff.hash);
    await options.store.recordWorkerIteration({
      id: call.iterationId,
      sessionId: current.id,
      iteration: kind === 'MECHANICAL_REPAIR' ? current.iteration + 1 : current.iteration,
      kind,
      startedAt: call.startedAt,
      completedAt: options.now(),
      result: call.result,
      diffHash: currentDiff.hash,
      providerResponseHash: hashValue(call.result),
    });
  };

  const revisionPacket = (qualityGateReport: QualityGateReport): WorkerRevisionInput => {
    if (currentDiff === undefined) throw new Error('A diff is required before worker revision.');
    if (approved === undefined)
      throw new Error('A frozen plan is required before worker revision.');
    return {
      approvedPlanHash: approved.hash,
      iteration: current.iteration + 1,
      openFindings,
      qualityGateFailures: qualityGateReport.failures,
      relevantDiff: currentDiff.patch,
      relevantFiles: [],
      constraints: {
        allowedAreas: approved.plan.expectedFileAreas,
        deniedAreas: ['.git'],
        networkAccess: 'ask',
        destructiveCommands: 'denied',
      },
    };
  };

  const requireCurrentDiff = (): WorkspaceDiff => {
    if (currentDiff === undefined) throw new Error('A worker diff is required for review.');
    return currentDiff;
  };

  await commit({type: 'SESSION_STARTED'});
  await commit({type: 'REPOSITORY_DISCOVERED'});

  const conversation: {role: 'user' | 'supervisor'; content: string}[] = [];
  let discovery = await callSupervisor(
    'analyzeRequirements',
    {userRequest: options.userRequest, conversation, projectSummary: options.projectSummary},
    async () =>
      await options.supervisor.analyzeRequirements(
        {userRequest: options.userRequest, conversation, projectSummary: options.projectSummary},
        options.supervisorContext,
      ),
  );
  while (!discovery.sufficient) {
    options.interaction.notify('requirements.questions', {discovery});
    const answer = await options.interaction.answerRequirements(discovery);
    if (answer === undefined) {
      await commit({type: 'TASK_CANCELLED'});
      return current;
    }
    conversation.push({role: 'supervisor', content: discovery.questions.join('\n')});
    conversation.push({role: 'user', content: answer});
    discovery = await callSupervisor(
      'analyzeRequirements',
      {userRequest: options.userRequest, conversation, projectSummary: options.projectSummary},
      async () =>
        await options.supervisor.analyzeRequirements(
          {userRequest: options.userRequest, conversation, projectSummary: options.projectSummary},
          options.supervisorContext,
        ),
    );
  }

  await commit({type: 'REQUIREMENTS_SUFFICIENT'});
  let version = 1;
  let draft = validateDraft(
    await callSupervisor(
      'draftPlan',
      {taskId: current.id, version, userRequest: options.userRequest, discovery},
      async () =>
        await options.supervisor.draftPlan(
          {
            taskId: current.id,
            version,
            createdAt: options.now(),
            userRequest: options.userRequest,
            discovery,
          },
          options.supervisorContext,
        ),
    ),
    current.id,
    version,
  );
  await options.store.savePlan(draft, renderTaskPlanMarkdown(draft));
  await commit({type: 'PLAN_DRAFTED', planVersion: version});

  let approved: ReturnType<typeof approvePlan> | undefined;
  while (approved === undefined) {
    const decision = await options.interaction.reviewPlan(draft);
    await options.store.recordUserDecision({
      id: options.nextId(),
      sessionId: current.id,
      kind: 'PLAN_REVIEW',
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
      version += 1;
      draft = validateDraft(
        await callSupervisor(
          'revisePlan',
          {currentPlan: draft, changeRequest: decision.message, version},
          async () =>
            await options.supervisor.revisePlan(
              {
                currentPlan: draft,
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
    if (decision.kind === 'approve') {
      approved = approvePlan(draft, options.now());
      const approvedAt = approved.plan.approvedAt;
      if (approvedAt === undefined) {
        throw new ProviderOutputValidationError('Frozen plan is missing its approval timestamp.');
      }
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
  }

  await commit({type: 'WORKSPACE_PREPARATION_STARTED'});
  workspace = await options.prepareWorkspace(current);
  await options.store.recordWorkspace(current.id, workspace);
  await commit({type: 'WORKSPACE_READY', workspace});
  assertWorkerMayStart(current, approved.plan, approved.hash);

  const initialInput = {
    approvedPlan: approved.plan,
    approvedPlanHash: approved.hash,
    projectSummary: options.projectSummary,
    workspacePath: workspace.path,
    constraints: {
      allowedAreas: approved.plan.expectedFileAreas,
      deniedAreas: ['.git'],
      networkAccess: 'ask' as const,
      destructiveCommands: 'denied' as const,
    },
    baselineResults: emptyGateReport(options.now),
    outputSchema: {schemaVersion: 1},
  };
  const initialCall = await callWorker(
    'INITIAL',
    initialInput,
    async () => await options.worker.execute(initialInput, workerContext()),
  );
  workerResult = initialCall.result;
  await recordWorkerCompletion(initialCall, 'INITIAL');
  const initialBlocker = blockingWorkerReason(workerResult);
  if (initialBlocker !== undefined) {
    await commit({type: 'TASK_PAUSED', reason: initialBlocker});
    return current;
  }
  await commit({type: 'WORKER_FINISHED'});

  try {
    for (;;) {
      while (current.state === 'RUNNING_QUALITY_GATES') {
        const commandGates = await options.runQualityGates(workspace.path);
        const policyGates = evaluateDiffPolicyGates({
          patch: requireCurrentDiff().patch,
          changedFiles: requireCurrentDiff().changedFiles,
          allowedAreas: approved.plan.expectedFileAreas,
          now: options.now,
        });
        const gates = mergeGateReports(commandGates, policyGates);
        await options.store.recordQualityGateRun({
          id: options.nextId(),
          sessionId: current.id,
          iteration: current.iteration,
          report: gates,
        });
        if (gates.status === 'PASSED') {
          latestPassingGates = gates;
          loopGuard.recordGateFailures([]);
          await commit({type: 'QUALITY_GATES_PASSED'});
          break;
        }
        loopGuard.recordGateFailures(gates.failures.map(({fingerprint}) => fingerprint));
        await commit({type: 'QUALITY_GATES_FAILED'});
        if (
          gates.failures.some(
            ({type}) =>
              type === 'secret-scan' || type === 'scope-check' || type === 'diff-size-check',
          )
        ) {
          await commit({
            type: 'TASK_PAUSED',
            reason: 'A security or approved-scope policy gate requires user review.',
          });
          return current;
        }
        loopGuard.recordMechanicalRepair();
        const packet = revisionPacket(gates);
        const repairCall = await callWorker(
          'MECHANICAL_REPAIR',
          packet,
          async () => await options.worker.revise(packet, workerContext()),
        );
        workerResult = repairCall.result;
        await recordWorkerCompletion(repairCall, 'MECHANICAL_REPAIR');
        const repairBlocker = blockingWorkerReason(workerResult);
        if (repairBlocker !== undefined) {
          await commit({type: 'TASK_PAUSED', reason: repairBlocker});
          return current;
        }
        await commit({type: 'MECHANICAL_REPAIR_FINISHED'});
      }

      if (current.state !== 'SUPERVISOR_REVIEW') break;
      loopGuard.recordSupervisorReview();
      const reviewDiff = requireCurrentDiff();
      if (latestPassingGates === undefined) {
        throw new Error('A passing quality gate report is required for supervisor review.');
      }
      const latestGates = latestPassingGates;
      const reviewInput = {
        approvedPlan: approved.plan,
        approvedPlanHash: approved.hash,
        workerResult,
        qualityGateReport: latestGates,
        relevantDiff: reviewDiff.patch,
        ...(previousDecision === undefined ? {} : {previousDecision}),
      };
      const decision = await callSupervisor(
        'reviewImplementation',
        reviewInput,
        async () =>
          await options.supervisor.reviewImplementation(reviewInput, options.supervisorContext),
      );
      validateFindingLifecycle(
        openFindings.map(({id}) => id),
        decision,
      );
      assertReviewMayApprove(
        decision,
        approved.plan,
        latestGates.status === 'PASSED',
        options.reviewPolicy,
      );
      loopGuard.recordFindingOccurrences(decision.openFindingIds);
      loopGuard.recordReview(decision.openFindingIds);
      await options.store.recordReviewDecision({
        id: options.nextId(),
        sessionId: current.id,
        iteration: current.iteration,
        phase: 'SEMANTIC',
        createdAt: options.now(),
        decision,
      });
      openFindings = decision.findings.filter(({id}) => decision.openFindingIds.includes(id));
      previousDecision = decision;

      if (decision.verdict === 'BLOCKED') {
        await commit({type: 'TASK_PAUSED', reason: decision.summary});
        return current;
      }
      if (decision.verdict === 'REVISE') {
        await commit({type: 'SUPERVISOR_REQUESTED_REVISION'});
        const packet = revisionPacket(latestGates);
        await commit({type: 'WORKER_REVISION_STARTED'});
        const revisionCall = await callWorker(
          'REVISION',
          packet,
          async () => await options.worker.revise(packet, workerContext()),
        );
        workerResult = revisionCall.result;
        await recordWorkerCompletion(revisionCall, 'REVISION');
        const revisionBlocker = blockingWorkerReason(workerResult);
        if (revisionBlocker !== undefined) {
          await commit({type: 'TASK_PAUSED', reason: revisionBlocker});
          return current;
        }
        await commit({type: 'WORKER_FINISHED'});
        continue;
      }

      await commit({type: 'SUPERVISOR_APPROVED'});
      loopGuard.recordSupervisorReview();
      const finalInput = {...reviewInput, reviewDecision: decision};
      const finalDecision = await callSupervisor(
        'finalReview',
        finalInput,
        async () => await options.supervisor.finalReview(finalInput, options.supervisorContext),
      );
      validateFindingLifecycle(
        openFindings.map(({id}) => id),
        finalDecision,
      );
      assertReviewMayApprove(
        finalDecision,
        approved.plan,
        latestGates.status === 'PASSED',
        options.reviewPolicy,
      );
      await options.store.recordReviewDecision({
        id: options.nextId(),
        sessionId: current.id,
        iteration: current.iteration,
        phase: 'FINAL',
        createdAt: options.now(),
        decision: finalDecision,
      });
      if (finalDecision.verdict === 'BLOCKED') {
        await commit({type: 'TASK_PAUSED', reason: finalDecision.summary});
        return current;
      }
      if (finalDecision.verdict === 'REVISE') {
        openFindings = finalDecision.findings.filter(({id}) =>
          finalDecision.openFindingIds.includes(id),
        );
        previousDecision = finalDecision;
        await commit({type: 'SUPERVISOR_REQUESTED_REVISION'});
        const packet = revisionPacket(latestGates);
        await commit({type: 'WORKER_REVISION_STARTED'});
        const revisionCall = await callWorker(
          'REVISION',
          packet,
          async () => await options.worker.revise(packet, workerContext()),
        );
        workerResult = revisionCall.result;
        await recordWorkerCompletion(revisionCall, 'REVISION');
        await commit({type: 'WORKER_FINISHED'});
        continue;
      }
      await commit({type: 'SUPERVISOR_APPROVED'});
      break;
    }
  } catch (error: unknown) {
    if (error instanceof LoopProtectionError) {
      await commit({type: 'TASK_PAUSED', reason: error.userMessage});
      return current;
    }
    throw error;
  }

  if (current.state !== 'TECHNICALLY_APPROVED') return current;
  currentDiff = await options.collectDiff(workspace);
  await commit({type: 'APPLY_REVIEW_READY'});
  const applyDecision = await options.interaction.reviewApply(current, currentDiff);
  await options.store.recordUserDecision({
    id: options.nextId(),
    sessionId: current.id,
    kind: 'APPLY_REVIEW',
    decision: applyDecision,
    createdAt: options.now(),
  });
  if (applyDecision === 'keep' || applyDecision === 'cancel') {
    const preserved = {...workspace, status: 'PRESERVED' as const};
    await options.store.recordWorkspace(current.id, preserved);
    await commit({
      type: 'TASK_PAUSED',
      reason: 'Execution worktree was preserved without applying.',
    });
    return current;
  }
  if (applyDecision === 'discard') {
    const discarded =
      options.discardWorkspace === undefined
        ? ({...workspace, status: 'DISCARDED'} as const)
        : await options.discardWorkspace(workspace);
    await options.store.recordWorkspace(current.id, discarded);
    await commit({type: 'TASK_CANCELLED'});
    return current;
  }

  await commit({type: 'APPLY_APPROVED'});
  const applied = await options.applyChanges(workspace);
  workspace = applied.workspace;
  await options.store.recordWorkspace(current.id, workspace);
  await commit({type: 'CHANGES_APPLIED'});
  return current;
};
