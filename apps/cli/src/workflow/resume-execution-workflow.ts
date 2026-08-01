import {createHash} from 'node:crypto';

import type {
  ExecutionWorkspace,
  ProjectSummary,
  QualityGateReport,
  ReviewDecision,
  ReviewFinding,
  TaskSession,
  WorkflowEvent,
  WorkflowEventRecord,
  WorkerExecutionInput,
  WorkerExecutionResult,
  WorkerRevisionInput,
} from '@agent-foreman/contracts';
import {
  ConfigurationError,
  LoopProtectionError,
  WorkflowLoopGuard,
  assertReviewMayApprove,
  hashTaskPlan,
  transitionWorkflow,
  validateFindingLifecycle,
  type WorkflowLoopLimits,
  type ReviewApprovalPolicy,
} from '@agent-foreman/core';
import type {ResumeSnapshot} from '@agent-foreman/persistence';
import type {
  ProviderExecutionContext,
  SupervisorProvider,
  WorkerProvider,
} from '@agent-foreman/provider-sdk';
import {evaluateDiffPolicyGates} from '@agent-foreman/quality-gates';
import type {WorkspaceDiff} from '@agent-foreman/workspace';

import {resumeApplyWorkflow} from './resume-apply-workflow.js';
import type {RealWorkflowInteraction, RealWorkflowStore} from './run-real-workflow.js';

export interface ResumeExecutionWorkflowOptions {
  readonly snapshot: ResumeSnapshot;
  readonly projectSummary: ProjectSummary;
  readonly supervisor: SupervisorProvider;
  readonly worker: WorkerProvider;
  readonly supervisorContext: ProviderExecutionContext;
  readonly store: RealWorkflowStore;
  readonly interaction: RealWorkflowInteraction;
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

const recoveredResult = (diff: WorkspaceDiff): WorkerExecutionResult => ({
  schemaVersion: 1,
  executionId: 'recovered-from-workspace',
  status: 'PARTIAL',
  summary: 'Recovered the worker result from persisted workspace changes after interruption.',
  changedFiles: [...diff.changedFiles],
  commandsRun: [],
  testsAdded: [],
  acceptanceCriteriaWorkedOn: [],
  assumptionsMade: ['Provider completion metadata was unavailable after interruption.'],
  blockers: [],
  knownIssues: ['The recovered changes require deterministic gates and full supervisor review.'],
});

export const resumeExecutionWorkflow = async (
  options: ResumeExecutionWorkflowOptions,
): Promise<TaskSession> => {
  let current = options.snapshot.session;
  const approvedRecord = options.snapshot.approvedPlan;
  const workspace = options.snapshot.workspace;
  if (approvedRecord?.hash === undefined || approvedRecord.plan.status !== 'APPROVED') {
    throw new ConfigurationError('Resume requires a persisted approved plan and immutable hash.');
  }
  if (hashTaskPlan(approvedRecord.plan) !== approvedRecord.hash) {
    throw new ConfigurationError('Persisted approved plan hash does not match its content.');
  }
  if (workspace === undefined) {
    throw new ConfigurationError('Resume requires a preserved execution workspace.');
  }
  const loopGuard = new WorkflowLoopGuard(options.limits);
  let currentDiff = await options.collectDiff(workspace);
  let workerResult = options.snapshot.lastWorkerIteration?.result ?? recoveredResult(currentDiff);
  let openFindings: ReviewFinding[] = [...options.snapshot.openFindings];
  let previousDecision: ReviewDecision | undefined = options.snapshot.lastReviewDecision?.decision;
  let latestGates = options.snapshot.latestQualityGateReport;
  let userDecisionContext: string[] = [];

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

  const context = (): ProviderExecutionContext => ({
    ...options.supervisorContext,
    executionWorkspace: workspace,
    permissions: {
      filesystem: 'workspace-write',
      shell: 'project-scoped',
      network: 'ask',
      workerLaunch: 'denied',
    },
  });

  const revisionPacket = (): WorkerRevisionInput => ({
    approvedPlanHash: approvedRecord.hash ?? '',
    iteration: current.iteration + 1,
    openFindings,
    qualityGateFailures: latestGates?.failures ?? [],
    relevantDiff: currentDiff.patch,
    relevantFiles: [],
    ...(userDecisionContext.length === 0 ? {} : {userDecisionContext}),
    constraints: {
      allowedAreas: approvedRecord.plan.expectedFileAreas,
      deniedAreas: ['.git'],
      networkAccess: 'ask',
      destructiveCommands: 'denied',
    },
  });

  const runWorker = async (kind: 'INITIAL' | 'MECHANICAL_REPAIR' | 'REVISION'): Promise<void> => {
    loopGuard.recordWorkerIteration();
    const descriptor = await options.worker.descriptor();
    const executionId = options.nextId();
    const iterationId = options.nextId();
    const startedAt = options.now();
    const initialInput: WorkerExecutionInput = {
      approvedPlan: approvedRecord.plan,
      approvedPlanHash: approvedRecord.hash ?? '',
      projectSummary: options.projectSummary,
      workspacePath: workspace.path,
      constraints: {
        allowedAreas: approvedRecord.plan.expectedFileAreas,
        deniedAreas: ['.git'],
        networkAccess: 'ask',
        destructiveCommands: 'denied',
      },
      baselineResults: latestGates ?? {
        status: 'PASSED',
        failures: [],
        startedAt,
        completedAt: startedAt,
        runs: [],
      },
      outputSchema: {schemaVersion: 1},
    };
    const request = kind === 'INITIAL' ? initialInput : revisionPacket();
    await options.store.recordProviderExecution({
      id: executionId,
      sessionId: current.id,
      role: 'worker',
      providerId: descriptor.id,
      ...(current.workerModel === undefined ? {} : {model: current.workerModel}),
      status: 'STARTED',
      startedAt,
      requestHash: hashValue(request),
    });
    await options.store.recordWorkerIteration({
      id: iterationId,
      sessionId: current.id,
      iteration: kind === 'MECHANICAL_REPAIR' ? current.iteration + 1 : current.iteration,
      kind,
      startedAt,
    });
    workerResult =
      kind === 'INITIAL'
        ? await options.worker.execute(initialInput, context())
        : await options.worker.revise(request as WorkerRevisionInput, context());
    currentDiff = await options.collectDiff(workspace);
    loopGuard.recordDiff(currentDiff.hash);
    await options.store.recordProviderExecution({
      id: executionId,
      sessionId: current.id,
      role: 'worker',
      providerId: descriptor.id,
      ...(current.workerModel === undefined ? {} : {model: current.workerModel}),
      status: 'COMPLETED',
      startedAt,
      completedAt: options.now(),
      ...(workerResult.providerSessionId === undefined
        ? {}
        : {providerSessionId: workerResult.providerSessionId}),
      requestHash: hashValue(request),
      result: workerResult,
    });
    await options.store.recordWorkerIteration({
      id: iterationId,
      sessionId: current.id,
      iteration: kind === 'MECHANICAL_REPAIR' ? current.iteration + 1 : current.iteration,
      kind,
      startedAt,
      completedAt: options.now(),
      result: workerResult,
      diffHash: currentDiff.hash,
      providerResponseHash: hashValue(workerResult),
    });
  };

  const lastPause = [...options.snapshot.events]
    .reverse()
    .find(({event}) => event.type === 'TASK_PAUSED');
  if (current.state === 'PAUSED') {
    if (lastPause === undefined) throw new ConfigurationError('Paused task has no recovery event.');
    await commit({type: 'TASK_RESUMED', resumeState: lastPause.previousState});
  }

  try {
    for (;;) {
      if (current.state === 'EXECUTING_WORKER') {
        const persistedIteration = options.snapshot.lastWorkerIteration;
        if (
          persistedIteration?.result !== undefined &&
          persistedIteration.iteration === current.iteration
        ) {
          workerResult = persistedIteration.result;
          await commit({type: 'WORKER_FINISHED'});
          continue;
        }
        await runWorker(current.iteration <= 1 ? 'INITIAL' : 'REVISION');
        if (workerResult.status === 'FAILED') {
          await commit({type: 'TASK_PAUSED', reason: workerResult.summary});
          return current;
        }
        if (workerResult.status === 'BLOCKED' || workerResult.blockers.length > 0) {
          await commit({type: 'USER_DECISION_REQUIRED'});
          continue;
        }
        await commit({type: 'WORKER_FINISHED'});
        continue;
      }

      if (current.state === 'AWAITING_USER_DECISION') {
        const questions = workerResult.blockers.map(
          (blocker) =>
            `${blocker.summary}\n${blocker.details}\nOptions: ${blocker.suggestedOptions.join(', ')}`,
        );
        const answer = await options.interaction.answerRequirements({
          summary: 'Worker execution needs a user-owned decision.',
          repositoryObservations: [],
          questions,
          proposedAssumptions: workerResult.blockers.flatMap(({suggestedOptions}) =>
            suggestedOptions.slice(0, 1),
          ),
          sufficient: false,
        });
        if (answer === undefined) {
          await commit({type: 'TASK_PAUSED', reason: 'User decision is still required.'});
          return current;
        }
        userDecisionContext = [answer];
        await options.store.recordUserDecision({
          id: options.nextId(),
          sessionId: current.id,
          kind: 'WORKER_BLOCKER',
          decision: answer,
          createdAt: options.now(),
        });
        await commit({type: 'USER_DECISION_RECEIVED'});
        continue;
      }

      if (current.state === 'REVISING_IMPLEMENTATION') {
        await commit({type: 'WORKER_REVISION_STARTED'});
        await runWorker('REVISION');
        userDecisionContext = [];
        await commit({type: 'WORKER_FINISHED'});
        continue;
      }

      if (current.state === 'RUNNING_QUALITY_GATES') {
        const commandGates = await options.runQualityGates(workspace.path);
        const gates = mergeGateReports(
          commandGates,
          evaluateDiffPolicyGates({
            patch: currentDiff.patch,
            changedFiles: currentDiff.changedFiles,
            allowedAreas: approvedRecord.plan.expectedFileAreas,
            now: options.now,
          }),
        );
        latestGates = gates;
        await options.store.recordQualityGateRun({
          id: options.nextId(),
          sessionId: current.id,
          iteration: current.iteration,
          report: gates,
        });
        if (gates.status === 'PASSED') {
          await commit({type: 'QUALITY_GATES_PASSED'});
          continue;
        }
        await commit({type: 'QUALITY_GATES_FAILED'});
        if (gates.failures.some(({type}) => type === 'secret-scan' || type === 'scope-check')) {
          await commit({
            type: 'TASK_PAUSED',
            reason: 'Security or scope policy review is required.',
          });
          return current;
        }
        continue;
      }

      if (current.state === 'REPAIRING_MECHANICAL_FAILURES') {
        loopGuard.recordMechanicalRepair();
        await runWorker('MECHANICAL_REPAIR');
        await commit({type: 'MECHANICAL_REPAIR_FINISHED'});
        continue;
      }

      if (current.state === 'SUPERVISOR_REVIEW') {
        if (latestGates?.status !== 'PASSED') {
          throw new ConfigurationError('Supervisor review resume requires passing quality gates.');
        }
        loopGuard.recordSupervisorReview();
        const reviewInput = {
          approvedPlan: approvedRecord.plan,
          approvedPlanHash: approvedRecord.hash,
          workerResult,
          qualityGateReport: latestGates,
          relevantDiff: currentDiff.patch,
          ...(previousDecision === undefined ? {} : {previousDecision}),
        };
        const decision = await options.supervisor.reviewImplementation(
          reviewInput,
          options.supervisorContext,
        );
        validateFindingLifecycle(
          openFindings.map(({id}) => id),
          decision,
        );
        assertReviewMayApprove(decision, approvedRecord.plan, true, options.reviewPolicy);
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
        if (decision.verdict === 'APPROVED') await commit({type: 'SUPERVISOR_APPROVED'});
        else if (decision.verdict === 'REVISE') {
          await commit({type: 'SUPERVISOR_REQUESTED_REVISION'});
        } else {
          await commit({type: 'TASK_PAUSED', reason: decision.summary});
          return current;
        }
        continue;
      }

      if (current.state === 'FINAL_REVIEW') {
        if (latestGates?.status !== 'PASSED' || previousDecision === undefined) {
          throw new ConfigurationError('Final review resume is missing its prior review evidence.');
        }
        loopGuard.recordSupervisorReview();
        const finalInput = {
          approvedPlan: approvedRecord.plan,
          approvedPlanHash: approvedRecord.hash,
          workerResult,
          qualityGateReport: latestGates,
          relevantDiff: currentDiff.patch,
          reviewDecision: previousDecision,
          previousDecision,
        };
        const decision = await options.supervisor.finalReview(
          finalInput,
          options.supervisorContext,
        );
        validateFindingLifecycle(
          openFindings.map(({id}) => id),
          decision,
        );
        assertReviewMayApprove(decision, approvedRecord.plan, true, options.reviewPolicy);
        await options.store.recordReviewDecision({
          id: options.nextId(),
          sessionId: current.id,
          iteration: current.iteration,
          phase: 'FINAL',
          createdAt: options.now(),
          decision,
        });
        if (decision.verdict === 'APPROVED') await commit({type: 'SUPERVISOR_APPROVED'});
        else if (decision.verdict === 'REVISE') {
          openFindings = decision.findings.filter(({id}) => decision.openFindingIds.includes(id));
          previousDecision = decision;
          await commit({type: 'SUPERVISOR_REQUESTED_REVISION'});
        } else {
          await commit({type: 'TASK_PAUSED', reason: decision.summary});
          return current;
        }
        continue;
      }

      if (current.state === 'TECHNICALLY_APPROVED') {
        await commit({type: 'APPLY_REVIEW_READY'});
        continue;
      }
      if (current.state === 'AWAITING_APPLY_APPROVAL') {
        const snapshot = await options.store.loadResumeSnapshot(current.id);
        if (snapshot === undefined) throw new ConfigurationError('Could not reload apply state.');
        return await resumeApplyWorkflow({
          snapshot,
          store: options.store,
          interaction: options.interaction,
          collectDiff: options.collectDiff,
          applyChanges: options.applyChanges,
          discardWorkspace: options.discardWorkspace,
          now: options.now,
          nextId: options.nextId,
        });
      }
      if (current.state === 'APPLYING_CHANGES') {
        const applied = await options.applyChanges(workspace);
        await options.store.recordWorkspace(current.id, applied.workspace);
        await commit({type: 'CHANGES_APPLIED', workspace: applied.workspace});
        return current;
      }
      if (current.state === 'COMPLETED' || current.state === 'CANCELLED') return current;
      throw new ConfigurationError(`Execution resume does not accept state ${current.state}.`);
    }
  } catch (error: unknown) {
    if (error instanceof LoopProtectionError) {
      await commit({type: 'TASK_PAUSED', reason: error.userMessage});
      return current;
    }
    throw error;
  }
};
