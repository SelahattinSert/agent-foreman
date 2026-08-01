import {createHash} from 'node:crypto';

import type {
  ExecutionWorkspace,
  NativeReviewPacket,
  ProjectSummary,
  QualityGateReport,
  ReviewFinding,
  RevisionSubmitInput,
  RuntimeResumePacket,
  RuntimeWorkspaceDiff,
  TaskPlan,
  TaskSession,
  WorkflowEvent,
  WorkflowEventRecord,
  WorkerExecutionInput,
  WorkerExecutionResult,
  WorkerRevisionInput,
} from '@agent-foreman/contracts';
import {
  AgentForemanError,
  ConfigurationError,
  LoopProtectionError,
  ProviderExecutionError,
  WorkflowLoopGuard,
  assertReviewMayApprove,
  transitionWorkflow,
  validateFindingLifecycle,
  type ReviewApprovalPolicy,
  type WorkflowLoopLimits,
} from '@agent-foreman/core';
import type {
  ResumeSnapshot,
  RuntimeRecordRepository,
  WorkflowStore,
} from '@agent-foreman/persistence';
import type {ProviderExecutionContext, WorkerProvider} from '@agent-foreman/provider-sdk';

export interface RuntimeExecutionDependencies {
  readonly store: WorkflowStore & RuntimeRecordRepository;
  readonly worker: WorkerProvider;
  readonly summarizeProject: (projectRoot: string) => Promise<ProjectSummary>;
  readonly prepareWorkspace: (
    session: TaskSession,
    strategy: 'cancel' | 'head-worktree' | 'include-tracked',
  ) => Promise<ExecutionWorkspace>;
  readonly collectDiff: (workspace: ExecutionWorkspace) => Promise<RuntimeWorkspaceDiff>;
  readonly runQualityGates: (
    workspacePath: string,
    diff: RuntimeWorkspaceDiff,
    approvedPlan: TaskPlan,
  ) => Promise<QualityGateReport>;
  readonly applyChanges: (
    workspace: ExecutionWorkspace,
  ) => Promise<{readonly workspace: ExecutionWorkspace; readonly diff: RuntimeWorkspaceDiff}>;
  readonly createWorkerContext: (
    session: TaskSession,
    workspace: ExecutionWorkspace,
  ) => ProviderExecutionContext;
  readonly loopLimits: WorkflowLoopLimits;
  readonly reviewPolicy: ReviewApprovalPolicy;
  readonly now: () => string;
  readonly newId: () => string;
}

interface WorkerCallResult {
  readonly result: WorkerExecutionResult;
  readonly diff: RuntimeWorkspaceDiff;
  readonly loopError?: InstanceType<typeof LoopProtectionError>;
}

const hashValue = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const hashWorkerResponse = (result: WorkerExecutionResult): string =>
  hashValue({
    status: result.status,
    summary: result.summary,
    changedFiles: result.changedFiles,
    commandsRun: result.commandsRun.map((command) => ({
      executable: command.executable,
      args: command.args,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
    })),
    testsAdded: result.testsAdded,
    acceptanceCriteriaWorkedOn: result.acceptanceCriteriaWorkedOn,
    assumptionsMade: result.assumptionsMade,
    blockers: result.blockers,
    knownIssues: result.knownIssues,
  });

const emptyGateReport = (now: () => string): QualityGateReport => {
  const timestamp = now();
  return {
    status: 'PASSED',
    failures: [],
    startedAt: timestamp,
    completedAt: timestamp,
    runs: [],
  };
};

const blockingReason = (result: WorkerExecutionResult): string | undefined => {
  if (result.status === 'FAILED') return `Worker failed: ${result.summary}`;
  if (result.status !== 'BLOCKED' && result.blockers.length === 0) return undefined;
  return result.blockers.length === 0
    ? `Worker is blocked: ${result.summary}`
    : result.blockers.map((blocker) => `${blocker.type}: ${blocker.summary}`).join('\n');
};

export class NativeExecutionCoordinator {
  public constructor(private readonly options: RuntimeExecutionDependencies) {}

  public async resume(sessionId: string): Promise<RuntimeResumePacket> {
    const snapshot = await this.options.store.loadResumeSnapshot(sessionId);
    if (snapshot === undefined) throw new ConfigurationError(`Task ${sessionId} was not found.`);
    const plan = snapshot.currentPlan?.plan;
    const planHash = snapshot.currentPlan?.hash;
    const approvedPlanHash = snapshot.approvedPlan?.hash;
    const base = {
      schemaVersion: 1 as const,
      session: snapshot.session,
      ...(plan === undefined ? {} : {plan}),
      ...(planHash === undefined ? {} : {planHash}),
      ...(approvedPlanHash === undefined ? {} : {approvedPlanHash}),
    };

    switch (snapshot.session.state) {
      case 'CREATED':
      case 'DISCOVERING_REPOSITORY':
      case 'REQUIREMENT_DISCOVERY':
      case 'DRAFTING_PLAN':
      case 'REVISING_PLAN':
        return {
          ...base,
          nextAction: 'CONTINUE_PLANNING',
          message: 'Continue native Codex requirement discovery or planning.',
        };
      case 'AWAITING_PLAN_REVIEW':
        return {
          ...base,
          nextAction: 'REVIEW_PLAN',
          message: 'Show the stored draft plan and request explicit plan approval.',
        };
      case 'PLAN_APPROVED':
        return {
          ...base,
          nextAction: 'START_WORKER',
          message: 'The frozen plan is authorized; the worker has not started.',
        };
      case 'SUPERVISOR_REVIEW':
      case 'FINAL_REVIEW':
      case 'AWAITING_APPLY_APPROVAL': {
        const phase =
          snapshot.session.state === 'SUPERVISOR_REVIEW'
            ? 'SEMANTIC'
            : snapshot.session.state === 'FINAL_REVIEW'
              ? 'FINAL'
              : 'APPLY';
        const reviewPacket = await this.reviewPacketFromSnapshot(snapshot, phase);
        return {
          ...base,
          session: reviewPacket.session,
          approvedPlanHash: reviewPacket.approvedPlanHash,
          nextAction: phase === 'APPLY' ? 'REQUEST_APPLY_APPROVAL' : 'SUBMIT_REVIEW',
          message:
            phase === 'APPLY'
              ? 'Technical review is complete; show the diff and request explicit apply approval.'
              : 'Resume native Codex review using the persisted evidence packet.',
          reviewPacket,
        };
      }
      case 'TECHNICALLY_APPROVED': {
        const current = await this.transition(snapshot.session, {type: 'APPLY_REVIEW_READY'});
        const reviewPacket = await this.reviewPacketFromSnapshot(
          {...snapshot, session: current},
          'APPLY',
        );
        return {
          ...base,
          session: current,
          approvedPlanHash: reviewPacket.approvedPlanHash,
          nextAction: 'REQUEST_APPLY_APPROVAL',
          message:
            'Technical review is complete; show the diff and request explicit apply approval.',
          reviewPacket,
        };
      }
      case 'COMPLETED':
        return {...base, nextAction: 'COMPLETED', message: 'The task is already complete.'};
      case 'FAILED':
      case 'CANCELLED':
        return {
          ...base,
          nextAction: 'TERMINAL',
          message: `The task is in terminal state ${snapshot.session.state}.`,
        };
      case 'PAUSED': {
        if (this.isFailedInitialWorkerPause(snapshot)) {
          const workspace = snapshot.workspace;
          if (workspace !== undefined) {
            const diff = await this.options.collectDiff(workspace);
            if (diff.changedFiles.length === 0) {
              return {
                ...base,
                nextAction: 'START_WORKER',
                message:
                  'The initial worker provider failed before producing changes. After the provider issue is fixed, explicitly retry the worker with the same approved plan hash and preserved workspace.',
              };
            }
          }
        }
        const reviewPacket = await this.optionalPausedReviewPacket(snapshot);
        return {
          ...base,
          nextAction: 'INSPECT_PAUSED',
          message:
            snapshot.session.statusMessage ??
            'The task is paused. Inspect its workspace and persisted evidence before continuing.',
          ...(reviewPacket === undefined ? {} : {reviewPacket}),
        };
      }
      case 'AWAITING_USER_DECISION':
        return {
          ...base,
          nextAction: 'MANUAL_RECOVERY',
          message:
            'The worker requires a user decision. Inspect the persisted blocker before continuing.',
        };
      case 'PREPARING_WORKSPACE':
      case 'EXECUTING_WORKER':
      case 'RUNNING_QUALITY_GATES':
      case 'REPAIRING_MECHANICAL_FAILURES':
      case 'REVISING_IMPLEMENTATION':
      case 'APPLYING_CHANGES': {
        const reason = `Runtime restarted while ${snapshot.session.state} was in progress. The isolated workspace was preserved; Agent Foreman will not silently replay a potentially non-idempotent operation.`;
        const paused = await this.transition(snapshot.session, {type: 'TASK_PAUSED', reason});
        return {
          ...base,
          session: paused,
          nextAction: 'MANUAL_RECOVERY',
          message: reason,
        };
      }
    }
  }

  public async start(
    session: TaskSession,
    approvedPlan: TaskPlan,
    approvedPlanHash: string,
    workspaceStrategy: 'cancel' | 'head-worktree' | 'include-tracked' = 'cancel',
  ): Promise<NativeReviewPacket> {
    let current = session;
    let workspace: ExecutionWorkspace;
    let loopGuard: WorkflowLoopGuard;
    try {
      const workerHealth = await this.options.worker.healthCheck();
      if (workerHealth.status === 'FAIL') {
        throw new ProviderExecutionError(`Worker health check failed: ${workerHealth.message}`);
      }
      if (current.state === 'PLAN_APPROVED') {
        loopGuard = new WorkflowLoopGuard(this.options.loopLimits);
        current = await this.transition(current, {type: 'WORKSPACE_PREPARATION_STARTED'});
        workspace = await this.options.prepareWorkspace(current, workspaceStrategy);
        await this.options.store.recordWorkspace(current.id, workspace);
        current = await this.transition(current, {type: 'WORKSPACE_READY', workspace});
      } else if (current.state === 'PAUSED') {
        const snapshot = await this.options.store.loadResumeSnapshot(current.id);
        if (snapshot === undefined || !this.isFailedInitialWorkerPause(snapshot)) {
          throw new ConfigurationError(
            'Only a failed initial worker call can be retried from the PAUSED state.',
          );
        }
        if (snapshot.workspace === undefined) {
          throw new ConfigurationError('The paused worker retry has no preserved workspace.');
        }
        workspace = snapshot.workspace;
        const retryDiff = await this.options.collectDiff(workspace);
        if (retryDiff.changedFiles.length > 0) {
          throw new ConfigurationError(
            'The paused worker workspace contains changes and cannot be retried automatically.',
            {diagnostics: {changedFiles: retryDiff.changedFiles.map(({path}) => path)}},
          );
        }
        loopGuard = this.loopGuardFromSnapshot(snapshot);
        this.assertIterationAvailable(current, true);
        current = await this.transition(current, {
          type: 'WORKER_RETRY_STARTED',
        });
      } else {
        throw new ConfigurationError(
          'Worker start requires PLAN_APPROVED or a safely retryable PAUSED state.',
        );
      }
      const summary = await this.options.summarizeProject(current.projectRoot);
      const input: WorkerExecutionInput = {
        approvedPlan,
        approvedPlanHash,
        projectSummary: summary,
        workspacePath: workspace.path,
        constraints: this.constraints(approvedPlan),
        baselineResults: emptyGateReport(this.options.now),
        outputSchema: {schemaVersion: 1},
      };
      const call = await this.callWorker(
        current,
        workspace,
        'INITIAL',
        input,
        loopGuard,
        async (context) => this.options.worker.execute(input, context),
      );
      if (call.loopError !== undefined) {
        current = await this.transition(current, {
          type: 'TASK_PAUSED',
          reason: call.loopError.message,
        });
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          call.result,
          emptyGateReport(this.options.now),
          call.diff,
          [],
        );
      }
      const blocked = blockingReason(call.result);
      if (blocked !== undefined) {
        current = await this.transition(current, {type: 'TASK_PAUSED', reason: blocked});
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          call.result,
          emptyGateReport(this.options.now),
          call.diff,
          [],
        );
      }
      current = await this.transition(current, {type: 'WORKER_FINISHED'});
      return await this.gateToReview(
        current,
        workspace,
        approvedPlan,
        approvedPlanHash,
        call.result,
        [],
        loopGuard,
      );
    } catch (error: unknown) {
      await this.pauseIfPossible(current, error);
      throw error;
    }
  }

  public async submitReview(input: RevisionSubmitInput): Promise<NativeReviewPacket> {
    const snapshot = await this.options.store.loadResumeSnapshot(input.sessionId);
    if (snapshot === undefined)
      throw new ConfigurationError(`Task ${input.sessionId} was not found.`);
    let current = snapshot.session;
    const approved = snapshot.approvedPlan;
    const workspace = snapshot.workspace;
    const workerResult = snapshot.lastWorkerIteration?.result;
    const gates = snapshot.latestQualityGateReport;
    if (
      approved?.hash === undefined ||
      approved.hash !== input.approvedPlanHash ||
      workspace === undefined ||
      workerResult === undefined ||
      gates === undefined
    ) {
      throw new ConfigurationError('Review submission is missing approved execution evidence.');
    }
    if (current.iteration !== input.iteration) {
      throw new ConfigurationError('Review submission targets a stale worker iteration.', {
        diagnostics: {expectedIteration: current.iteration, receivedIteration: input.iteration},
      });
    }
    if (current.state !== 'SUPERVISOR_REVIEW' && current.state !== 'FINAL_REVIEW') {
      throw new ConfigurationError('The task is not awaiting native supervisor review.', {
        diagnostics: {state: current.state},
      });
    }
    const loopGuard = this.loopGuardFromSnapshot(snapshot);
    validateFindingLifecycle(
      snapshot.openFindings.map(({id}) => id),
      input.review,
    );
    assertReviewMayApprove(
      input.review,
      approved.plan,
      gates.status === 'PASSED',
      this.options.reviewPolicy,
    );
    const phase = current.state === 'FINAL_REVIEW' ? 'FINAL' : 'SEMANTIC';
    await this.options.store.recordReviewDecision({
      id: this.options.newId(),
      sessionId: current.id,
      iteration: current.iteration,
      phase,
      createdAt: this.options.now(),
      decision: input.review,
    });
    const openFindings = input.review.findings.filter(({id}) =>
      input.review.openFindingIds.includes(id),
    );
    const diff = await this.options.collectDiff(workspace);
    try {
      loopGuard.recordSupervisorReview();
      loopGuard.recordFindingOccurrences(input.review.openFindingIds);
      loopGuard.recordReview(input.review.openFindingIds);
    } catch (error: unknown) {
      if (!(error instanceof LoopProtectionError)) throw error;
      current = await this.transition(current, {type: 'TASK_PAUSED', reason: error.message});
      return this.packet(current, approved.hash, 'PAUSED', workerResult, gates, diff, openFindings);
    }
    if (input.review.verdict === 'BLOCKED') {
      current = await this.transition(current, {
        type: 'TASK_PAUSED',
        reason: input.review.summary,
      });
      return this.packet(current, approved.hash, 'PAUSED', workerResult, gates, diff, openFindings);
    }
    if (input.review.verdict === 'APPROVED') {
      current = await this.transition(current, {type: 'SUPERVISOR_APPROVED'});
      if (current.state === 'FINAL_REVIEW') {
        return this.packet(
          current,
          approved.hash,
          'FINAL',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      current = await this.transition(current, {type: 'APPLY_REVIEW_READY'});
      return this.packet(current, approved.hash, 'APPLY', workerResult, gates, diff, openFindings);
    }
    current = await this.transition(current, {type: 'SUPERVISOR_REQUESTED_REVISION'});
    current = await this.transition(current, {type: 'WORKER_REVISION_STARTED'});
    const packet: WorkerRevisionInput = {
      approvedPlanHash: approved.hash,
      iteration: current.iteration,
      openFindings,
      qualityGateFailures: gates.failures,
      relevantDiff: diff.patch,
      relevantFiles: [],
      constraints: this.constraints(approved.plan),
    };
    const call = await this.callWorker(
      current,
      workspace,
      'REVISION',
      packet,
      loopGuard,
      async (context) => this.options.worker.revise(packet, context),
    );
    if (call.loopError !== undefined) {
      current = await this.transition(current, {
        type: 'TASK_PAUSED',
        reason: call.loopError.message,
      });
      return this.packet(
        current,
        approved.hash,
        'PAUSED',
        call.result,
        gates,
        call.diff,
        openFindings,
      );
    }
    const blocked = blockingReason(call.result);
    if (blocked !== undefined) {
      current = await this.transition(current, {type: 'TASK_PAUSED', reason: blocked});
      return this.packet(
        current,
        approved.hash,
        'PAUSED',
        call.result,
        gates,
        call.diff,
        openFindings,
      );
    }
    current = await this.transition(current, {type: 'WORKER_FINISHED'});
    return await this.gateToReview(
      current,
      workspace,
      approved.plan,
      approved.hash,
      call.result,
      openFindings,
      loopGuard,
    );
  }

  public async currentDiff(sessionId: string): Promise<{
    readonly session: TaskSession;
    readonly workspace: ExecutionWorkspace;
    readonly diff: RuntimeWorkspaceDiff;
  }> {
    const snapshot = await this.options.store.loadResumeSnapshot(sessionId);
    if (snapshot?.workspace === undefined) {
      throw new ConfigurationError('The task has no persisted execution workspace.');
    }
    return {
      session: snapshot.session,
      workspace: snapshot.workspace,
      diff: await this.options.collectDiff(snapshot.workspace),
    };
  }

  public async apply(
    session: TaskSession,
    workspace: ExecutionWorkspace,
  ): Promise<{
    readonly session: TaskSession;
    readonly workspace: ExecutionWorkspace;
    readonly diff: RuntimeWorkspaceDiff;
  }> {
    if (session.state !== 'APPLYING_CHANGES') {
      throw new ConfigurationError('Changes can only be applied from APPLYING_CHANGES.');
    }
    const result = await this.options.applyChanges(workspace);
    await this.options.store.recordWorkspace(session.id, result.workspace);
    const completed = await this.transition(session, {
      type: 'CHANGES_APPLIED',
      workspace: result.workspace,
    });
    return {session: completed, workspace: result.workspace, diff: result.diff};
  }

  private async gateToReview(
    initialSession: TaskSession,
    workspace: ExecutionWorkspace,
    approvedPlan: TaskPlan,
    approvedPlanHash: string,
    initialWorkerResult: WorkerExecutionResult,
    openFindings: readonly ReviewFinding[],
    loopGuard: WorkflowLoopGuard,
  ): Promise<NativeReviewPacket> {
    let current = initialSession;
    let workerResult = initialWorkerResult;
    let diff = await this.options.collectDiff(workspace);
    for (let repair = 0; ; repair += 1) {
      const gates = await this.options.runQualityGates(workspace.path, diff, approvedPlan);
      await this.options.store.recordQualityGateRun({
        id: this.options.newId(),
        sessionId: current.id,
        iteration: current.iteration,
        report: gates,
      });
      try {
        loopGuard.recordGateFailures(gates.failures.map(({fingerprint}) => fingerprint));
      } catch (error: unknown) {
        if (!(error instanceof LoopProtectionError)) throw error;
        current = await this.transition(current, {type: 'TASK_PAUSED', reason: error.message});
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      if (gates.status === 'PASSED') {
        current = await this.transition(current, {type: 'QUALITY_GATES_PASSED'});
        return this.packet(
          current,
          approvedPlanHash,
          'SEMANTIC',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      current = await this.transition(current, {type: 'QUALITY_GATES_FAILED'});
      const requiresHuman = gates.failures.some(({type}) =>
        ['secret-scan', 'scope-check', 'diff-size-check', 'changed-files-check'].includes(type),
      );
      if (
        gates.status === 'CANCELLED' ||
        requiresHuman ||
        repair >= this.options.loopLimits.maxMechanicalRepairs
      ) {
        const reason = requiresHuman
          ? 'A security or approved-scope gate requires human review.'
          : repair >= this.options.loopLimits.maxMechanicalRepairs
            ? 'Maximum mechanical repair attempts reached.'
            : 'Quality gates were cancelled.';
        current = await this.transition(current, {type: 'TASK_PAUSED', reason});
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      this.assertIterationAvailable(current, true);
      const packet: WorkerRevisionInput = {
        approvedPlanHash,
        iteration: current.iteration + 1,
        openFindings: [...openFindings],
        qualityGateFailures: gates.failures,
        relevantDiff: diff.patch,
        relevantFiles: [],
        constraints: this.constraints(approvedPlan),
      };
      try {
        loopGuard.recordMechanicalRepair();
      } catch (error: unknown) {
        if (!(error instanceof LoopProtectionError)) throw error;
        current = await this.transition(current, {type: 'TASK_PAUSED', reason: error.message});
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      const call = await this.callWorker(
        current,
        workspace,
        'MECHANICAL_REPAIR',
        packet,
        loopGuard,
        async (context) => this.options.worker.revise(packet, context),
      );
      workerResult = call.result;
      diff = call.diff;
      if (call.loopError !== undefined) {
        current = await this.transition(current, {
          type: 'TASK_PAUSED',
          reason: call.loopError.message,
        });
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      const blocked = blockingReason(workerResult);
      if (blocked !== undefined) {
        current = await this.transition(current, {type: 'TASK_PAUSED', reason: blocked});
        return this.packet(
          current,
          approvedPlanHash,
          'PAUSED',
          workerResult,
          gates,
          diff,
          openFindings,
        );
      }
      current = await this.transition(current, {type: 'MECHANICAL_REPAIR_FINISHED'});
    }
  }

  private async callWorker(
    session: TaskSession,
    workspace: ExecutionWorkspace,
    kind: 'INITIAL' | 'MECHANICAL_REPAIR' | 'REVISION',
    request: WorkerExecutionInput | WorkerRevisionInput,
    loopGuard: WorkflowLoopGuard,
    invoke: (context: ProviderExecutionContext) => Promise<WorkerExecutionResult>,
  ): Promise<WorkerCallResult> {
    this.assertIterationAvailable(session, kind === 'MECHANICAL_REPAIR');
    const descriptor = await this.options.worker.descriptor();
    const executionId = this.options.newId();
    const iterationId = this.options.newId();
    const startedAt = this.options.now();
    const requestHash = hashValue(request);
    await this.options.store.recordProviderExecution({
      id: executionId,
      sessionId: session.id,
      role: 'worker',
      providerId: descriptor.id,
      ...(session.workerModel === undefined ? {} : {model: session.workerModel}),
      status: 'STARTED',
      startedAt,
      requestHash,
    });
    try {
      await this.options.store.recordWorkerIteration({
        id: iterationId,
        sessionId: session.id,
        iteration: session.iteration,
        kind,
        startedAt,
      });
      const result = await invoke(this.options.createWorkerContext(session, workspace));
      const diff = await this.options.collectDiff(workspace);
      const providerResponseHash = hashWorkerResponse(result);
      await this.options.store.recordProviderExecution({
        id: executionId,
        sessionId: session.id,
        role: 'worker',
        providerId: descriptor.id,
        ...(session.workerModel === undefined ? {} : {model: session.workerModel}),
        status: 'COMPLETED',
        startedAt,
        completedAt: this.options.now(),
        ...(result.providerSessionId === undefined
          ? {}
          : {providerSessionId: result.providerSessionId}),
        requestHash,
        result,
      });
      await this.options.store.recordWorkerIteration({
        id: iterationId,
        sessionId: session.id,
        iteration: session.iteration,
        kind,
        startedAt,
        completedAt: this.options.now(),
        result,
        diffHash: diff.hash,
        providerResponseHash,
      });
      if (result.tokenUsage !== undefined) {
        await this.options.store.recordTokenUsage({
          id: this.options.newId(),
          sessionId: session.id,
          providerExecutionId: executionId,
          role: 'worker',
          usage: result.tokenUsage,
          createdAt: this.options.now(),
        });
      }
      let loopError: InstanceType<typeof LoopProtectionError> | undefined;
      try {
        loopGuard.recordWorkerIteration();
        loopGuard.recordDiff(diff.hash);
        loopGuard.recordProviderResponse(providerResponseHash);
      } catch (error: unknown) {
        if (!(error instanceof LoopProtectionError)) throw error;
        loopError = error;
      }
      return {result, diff, ...(loopError === undefined ? {} : {loopError})};
    } catch (error: unknown) {
      await this.options.store.recordProviderExecution({
        id: executionId,
        sessionId: session.id,
        role: 'worker',
        providerId: descriptor.id,
        ...(session.workerModel === undefined ? {} : {model: session.workerModel}),
        status: 'FAILED',
        startedAt,
        completedAt: this.options.now(),
        requestHash,
        errorCode:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'AF_PROVIDER_EXECUTION',
      });
      if (error instanceof AgentForemanError) throw error;
      throw new ProviderExecutionError('Worker execution failed.', {cause: error});
    }
  }

  private constraints(plan: TaskPlan): WorkerExecutionInput['constraints'] {
    return {
      allowedAreas: plan.expectedFileAreas,
      deniedAreas: ['.git'],
      networkAccess: 'ask',
      destructiveCommands: 'denied',
    };
  }

  private loopGuardFromSnapshot(snapshot: ResumeSnapshot): WorkflowLoopGuard {
    const guard = new WorkflowLoopGuard(this.options.loopLimits);
    for (const iteration of snapshot.workerIterations) {
      if (iteration.completedAt === undefined || iteration.result === undefined) continue;
      guard.recordWorkerIteration();
      if (iteration.kind === 'MECHANICAL_REPAIR') guard.recordMechanicalRepair();
      if (iteration.diffHash !== undefined) guard.recordDiff(iteration.diffHash);
      if (iteration.providerResponseHash !== undefined) {
        guard.recordProviderResponse(iteration.providerResponseHash);
      }
    }
    for (const run of snapshot.qualityGateRuns) {
      guard.recordGateFailures(run.report.failures.map(({fingerprint}) => fingerprint));
    }
    for (const review of snapshot.reviewDecisions) {
      guard.recordSupervisorReview();
      guard.recordFindingOccurrences(review.decision.openFindingIds);
      guard.recordReview(review.decision.openFindingIds);
    }
    return guard;
  }

  private isFailedInitialWorkerPause(snapshot: ResumeSnapshot): boolean {
    const lastPause = [...snapshot.events]
      .reverse()
      .find(({event}) => event.type === 'TASK_PAUSED');
    return (
      snapshot.session.state === 'PAUSED' &&
      lastPause?.previousState === 'EXECUTING_WORKER' &&
      snapshot.workspace !== undefined &&
      snapshot.approvedPlan?.hash !== undefined &&
      snapshot.lastProviderExecution?.status === 'FAILED' &&
      snapshot.lastWorkerIteration?.kind === 'INITIAL' &&
      snapshot.lastWorkerIteration.result === undefined
    );
  }

  private assertIterationAvailable(session: TaskSession, incrementsAfterWorker = false): void {
    const effectiveIteration = session.iteration + (incrementsAfterWorker ? 1 : 0);
    if (effectiveIteration > this.options.loopLimits.maxWorkerIterations) {
      throw new LoopProtectionError('Maximum worker iterations reached.', {
        diagnostics: {
          currentIteration: session.iteration,
          maximum: this.options.loopLimits.maxWorkerIterations,
        },
      });
    }
  }

  private packet(
    session: TaskSession,
    approvedPlanHash: string,
    phase: NativeReviewPacket['phase'],
    workerResult: WorkerExecutionResult,
    qualityGateReport: QualityGateReport,
    diff: RuntimeWorkspaceDiff,
    openFindings: readonly ReviewFinding[],
  ): NativeReviewPacket {
    return {
      schemaVersion: 1,
      session,
      approvedPlanHash,
      phase,
      workerResult,
      qualityGateReport,
      diff,
      openFindings: [...openFindings],
    };
  }

  private async reviewPacketFromSnapshot(
    snapshot: ResumeSnapshot,
    phase: NativeReviewPacket['phase'],
  ): Promise<NativeReviewPacket> {
    const approvedPlanHash = snapshot.approvedPlan?.hash;
    const workspace = snapshot.workspace;
    const workerResult = snapshot.lastWorkerIteration?.result;
    const qualityGateReport = snapshot.latestQualityGateReport;
    if (
      approvedPlanHash === undefined ||
      workspace === undefined ||
      workerResult === undefined ||
      qualityGateReport === undefined
    ) {
      throw new ConfigurationError('The persisted session is missing review evidence.', {
        diagnostics: {
          sessionId: snapshot.session.id,
          approvedPlanHashPresent: approvedPlanHash !== undefined,
          workspacePresent: workspace !== undefined,
          workerResultPresent: workerResult !== undefined,
          qualityGateReportPresent: qualityGateReport !== undefined,
        },
      });
    }
    const diff = await this.options.collectDiff(workspace);
    return this.packet(
      snapshot.session,
      approvedPlanHash,
      phase,
      workerResult,
      qualityGateReport,
      diff,
      snapshot.openFindings,
    );
  }

  private async optionalPausedReviewPacket(
    snapshot: ResumeSnapshot,
  ): Promise<NativeReviewPacket | undefined> {
    if (
      snapshot.approvedPlan?.hash === undefined ||
      snapshot.workspace === undefined ||
      snapshot.lastWorkerIteration?.result === undefined ||
      snapshot.latestQualityGateReport === undefined
    ) {
      return undefined;
    }
    return await this.reviewPacketFromSnapshot(snapshot, 'PAUSED');
  }

  private async transition(session: TaskSession, event: WorkflowEvent): Promise<TaskSession> {
    const timestamp = this.options.now();
    const next = transitionWorkflow(session, event, timestamp);
    const record: WorkflowEventRecord = {
      id: this.options.newId(),
      sessionId: session.id,
      timestamp,
      previousState: session.state,
      nextState: next.state,
      event,
    };
    await this.options.store.commitTransition(session, next, record);
    return next;
  }

  private async pauseIfPossible(session: TaskSession, error: unknown): Promise<void> {
    if (['PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(session.state)) return;
    const reason = error instanceof Error ? error.message : 'Execution failed unexpectedly.';
    await this.transition(session, {type: 'TASK_PAUSED', reason}).catch(() => undefined);
  }
}
