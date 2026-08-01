import {randomUUID} from 'node:crypto';
import path from 'node:path';

import {
  ApprovalChallengeSchema,
  ApplyApproveInputSchema,
  ApplyRequestInputSchema,
  PlanApprovalRequestInputSchema,
  PlanApproveInputSchema,
  PlanSubmitInputSchema,
  RuntimeStatusInputSchema,
  RuntimeResumeInputSchema,
  RevisionSubmitInputSchema,
  SessionCreateInputSchema,
  WorkerStartInputSchema,
  type ApprovalChallenge,
  type AppliedChangesResult,
  type ApplyApprovalRequest,
  type ApplyApproveInput,
  type ApplyRequestInput,
  type NativeReviewPacket,
  type RuntimeResumeInput,
  type RuntimeResumePacket,
  type PlanApprovalRequestInput,
  type PlanApproveInput,
  type PlanSubmitInput,
  type SessionCreateInput,
  type TaskPlan,
  type TaskSession,
  type WorkflowEvent,
  type WorkflowEventRecord,
  type WorkerStartInput,
  type RevisionSubmitInput,
} from '@agent-foreman/contracts';
import {
  ConfigurationError,
  PermissionDeniedError,
  PlanHashMismatchError,
  PlanNotApprovedError,
  approvePlan,
  assertWorkerMayStart,
  hashTaskPlan,
  transitionWorkflow,
} from '@agent-foreman/core';
import type {
  ApprovalChallengeRepository,
  PlanRecord,
  WorkflowStore,
} from '@agent-foreman/persistence';

import type {NativeExecutionCoordinator} from './execution.js';

export type ConfirmationSource = 'tty' | 'mcp-user-confirmation' | 'skill';

export interface TrustedConfirmation {
  readonly trusted: boolean;
  readonly source: ConfirmationSource;
}

export interface HeadlessRuntimeServiceOptions {
  readonly store: WorkflowStore & ApprovalChallengeRepository;
  readonly workerProvider: string;
  readonly workerModel?: string;
  readonly now?: () => string;
  readonly newId?: () => string;
  readonly approvalTtlMs?: number;
  readonly allowedProjectRoot?: string;
  readonly execution?: NativeExecutionCoordinator;
}

export interface SubmittedPlan {
  readonly session: TaskSession;
  readonly planHash: string;
}

export interface ApprovedPlan {
  readonly session: TaskSession;
  readonly plan: TaskPlan;
  readonly approvedPlanHash: string;
}

export interface WorkerStartAuthorization {
  readonly session: TaskSession;
  readonly plan: TaskPlan;
  readonly approvedPlanHash: string;
}

const defaultId = (): string => randomUUID();
const defaultNow = (): string => new Date().toISOString();
const defaultApprovalTtlMs = 5 * 60 * 1_000;

export class HeadlessRuntimeService {
  private readonly store: WorkflowStore & ApprovalChallengeRepository;
  private readonly workerProvider: string;
  private readonly workerModel: string | undefined;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly approvalTtlMs: number;
  private readonly allowedProjectRoot: string | undefined;
  private readonly execution: NativeExecutionCoordinator | undefined;

  public constructor(options: HeadlessRuntimeServiceOptions) {
    this.store = options.store;
    this.workerProvider = options.workerProvider;
    this.workerModel = options.workerModel;
    this.now = options.now ?? defaultNow;
    this.newId = options.newId ?? defaultId;
    this.approvalTtlMs = options.approvalTtlMs ?? defaultApprovalTtlMs;
    this.allowedProjectRoot =
      options.allowedProjectRoot === undefined
        ? undefined
        : path.resolve(options.allowedProjectRoot);
    this.execution = options.execution;
  }

  public async sessionCreate(rawInput: SessionCreateInput): Promise<TaskSession> {
    const input = SessionCreateInputSchema.parse(rawInput);
    const projectRoot = path.resolve(input.projectRoot);
    if (this.allowedProjectRoot !== undefined && projectRoot !== this.allowedProjectRoot) {
      throw new PermissionDeniedError(
        'The MCP runtime may create sessions only for its configured project root.',
        {diagnostics: {projectRoot, allowedProjectRoot: this.allowedProjectRoot}},
      );
    }
    const timestamp = this.now();
    const session: TaskSession = {
      id: this.newId(),
      createdAt: timestamp,
      updatedAt: timestamp,
      projectRoot,
      ...(input.task === undefined ? {} : {userRequest: input.task}),
      frontendProvider: input.frontendProvider,
      supervisorProvider: input.frontendProvider,
      workerProvider: this.workerProvider,
      ...(this.workerModel === undefined ? {} : {workerModel: this.workerModel}),
      profileName: input.profileName,
      state: 'CREATED',
      iteration: 0,
    };
    await this.store.createSession(session);
    return this.transition(session, {type: 'SESSION_STARTED'});
  }

  public async planSubmit(rawInput: PlanSubmitInput): Promise<SubmittedPlan> {
    const input = PlanSubmitInputSchema.parse(rawInput);
    let session = await this.requireSession(input.sessionId);
    if (input.plan.taskId !== session.id) {
      throw new ConfigurationError('The submitted plan belongs to a different task session.', {
        diagnostics: {planTaskId: input.plan.taskId, sessionId: session.id},
      });
    }
    if (session.state === 'DISCOVERING_REPOSITORY') {
      session = await this.transition(session, {type: 'REPOSITORY_DISCOVERED'});
    }
    if (session.state === 'REQUIREMENT_DISCOVERY') {
      session = await this.transition(session, {type: 'REQUIREMENTS_SUFFICIENT'});
    }
    if (session.state === 'AWAITING_PLAN_REVIEW') {
      const currentVersion = session.currentPlanVersion;
      if (currentVersion === undefined || input.plan.version !== currentVersion + 1) {
        throw new ConfigurationError('A plan revision must increment the current version by one.', {
          diagnostics: {currentVersion, submittedVersion: input.plan.version},
        });
      }
      const current = await this.requirePlanRecord(session.id, currentVersion);
      const superseded: TaskPlan = {...current.plan, status: 'SUPERSEDED'};
      await this.store.savePlan(superseded, current.markdown, hashTaskPlan(superseded));
      session = await this.transition(session, {type: 'PLAN_CHANGE_REQUESTED'});
    }
    if (session.state !== 'DRAFTING_PLAN' && session.state !== 'REVISING_PLAN') {
      throw new ConfigurationError('A draft plan can only be submitted during planning.', {
        diagnostics: {sessionId: session.id, state: session.state},
      });
    }
    const planHash = hashTaskPlan(input.plan);
    await this.store.savePlan(input.plan, input.markdown, planHash);
    session = await this.transition(session, {
      type: 'PLAN_DRAFTED',
      planVersion: input.plan.version,
    });
    return {session, planHash};
  }

  public async planApprovalRequest(rawInput: PlanApprovalRequestInput): Promise<ApprovalChallenge> {
    const input = PlanApprovalRequestInputSchema.parse(rawInput);
    const session = await this.requireSession(input.sessionId);
    if (
      session.state !== 'AWAITING_PLAN_REVIEW' ||
      session.currentPlanVersion !== input.planVersion
    ) {
      throw new PlanNotApprovedError('The requested plan is not awaiting user approval.', {
        diagnostics: {
          sessionId: session.id,
          state: session.state,
          currentPlanVersion: session.currentPlanVersion,
        },
      });
    }
    const record = await this.requirePlanRecord(session.id, input.planVersion);
    const canonicalHash = hashTaskPlan(record.plan);
    if (record.hash !== input.planHash || canonicalHash !== input.planHash) {
      throw new PlanHashMismatchError(
        'The approval request does not match the stored draft hash.',
        {
          diagnostics: {canonicalHash, requestedHash: input.planHash, storedHash: record.hash},
        },
      );
    }
    const createdAt = this.now();
    const challenge = ApprovalChallengeSchema.parse({
      schemaVersion: 1,
      id: this.newId(),
      sessionId: session.id,
      purpose: 'PLAN',
      subjectHash: input.planHash,
      planVersion: input.planVersion,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + this.approvalTtlMs).toISOString(),
      status: 'PENDING',
    });
    await this.store.createApprovalChallenge(challenge);
    return challenge;
  }

  public async planApprove(
    rawInput: PlanApproveInput,
    confirmation: TrustedConfirmation,
  ): Promise<ApprovedPlan> {
    const input = PlanApproveInputSchema.parse(rawInput);
    if (
      !confirmation.trusted ||
      (confirmation.source !== 'tty' && confirmation.source !== 'mcp-user-confirmation')
    ) {
      throw new PermissionDeniedError(
        'Plan approval requires a trusted, explicit user confirmation path.',
        {diagnostics: {source: confirmation.source}},
      );
    }
    const challenge = await this.store.getApprovalChallenge(input.challengeId);
    if (challenge?.status !== 'PENDING') {
      throw new PermissionDeniedError(
        'The approval challenge is not pending or was already used.',
        {diagnostics: {challengeId: input.challengeId}},
      );
    }
    const session = await this.requireSession(input.sessionId);
    if (session.state !== 'AWAITING_PLAN_REVIEW' || session.currentPlanVersion === undefined) {
      throw new PlanNotApprovedError('No draft plan is currently awaiting approval.');
    }
    const record = await this.requirePlanRecord(session.id, session.currentPlanVersion);
    const draftHash = hashTaskPlan(record.plan);
    if (record.hash !== input.planHash || draftHash !== input.planHash) {
      throw new PlanHashMismatchError('The approval does not match the stored draft hash.');
    }
    const approvedAt = this.now();
    const challengeConsumption = {
      challengeId: input.challengeId,
      sessionId: session.id,
      purpose: 'PLAN' as const,
      subjectHash: input.planHash,
      consumedAt: approvedAt,
    };
    const approved = approvePlan(record.plan, approvedAt);
    const approval = {
      taskId: session.id,
      planVersion: approved.plan.version,
      hash: approved.hash,
      approvedAt,
    };
    const transition = this.prepareTransition(session, {
      type: 'PLAN_APPROVED',
      planVersion: approved.plan.version,
    });
    await this.store.commitPlanApproval({
      challenge: challengeConsumption,
      plan: approved.plan,
      markdown: record.markdown,
      planHash: approved.hash,
      approval,
      previousSession: session,
      nextSession: transition.next,
      event: transition.record,
    });
    return {session: transition.next, plan: approved.plan, approvedPlanHash: approved.hash};
  }

  public async assertWorkerStartAllowed(
    rawInput: WorkerStartInput,
  ): Promise<WorkerStartAuthorization> {
    const input = WorkerStartInputSchema.parse(rawInput);
    const session = await this.requireSession(input.sessionId);
    if (session.approvedPlanVersion === undefined) {
      throw new PlanNotApprovedError('Worker execution requires an explicitly approved plan.');
    }
    const [record, approval] = await Promise.all([
      this.requirePlanRecord(session.id, session.approvedPlanVersion),
      this.store.getPlanApproval(session.id, session.approvedPlanVersion),
    ]);
    if (approval === undefined) {
      throw new PlanNotApprovedError('The durable plan approval record is missing.');
    }
    if (approval.hash !== input.approvedPlanHash || record.hash !== approval.hash) {
      throw new PlanHashMismatchError(
        'Worker authorization does not match the approved plan hash.',
      );
    }
    assertWorkerMayStart(session, record.plan, input.approvedPlanHash);
    return {
      session,
      plan: record.plan,
      approvedPlanHash: input.approvedPlanHash,
    };
  }

  public async workerStart(rawInput: WorkerStartInput): Promise<NativeReviewPacket> {
    const input = WorkerStartInputSchema.parse(rawInput);
    const authorization = await this.assertWorkerStartAllowed(input);
    if (this.execution === undefined) {
      throw new ConfigurationError('No real worker execution engine is configured.');
    }
    return await this.execution.start(
      authorization.session,
      authorization.plan,
      authorization.approvedPlanHash,
      input.workspaceStrategy ?? 'cancel',
    );
  }

  public async reviewSubmit(rawInput: RevisionSubmitInput): Promise<NativeReviewPacket> {
    const input = RevisionSubmitInputSchema.parse(rawInput);
    if (this.execution === undefined) {
      throw new ConfigurationError('No real worker execution engine is configured.');
    }
    await this.assertWorkerStartAllowed({
      sessionId: input.sessionId,
      approvedPlanHash: input.approvedPlanHash,
    });
    return await this.execution.submitReview(input);
  }

  public async applyRequest(rawInput: ApplyRequestInput): Promise<ApplyApprovalRequest> {
    const input = ApplyRequestInputSchema.parse(rawInput);
    if (this.execution === undefined) {
      throw new ConfigurationError('No real workspace apply engine is configured.');
    }
    const current = await this.execution.currentDiff(input.sessionId);
    if (current.session.state !== 'AWAITING_APPLY_APPROVAL') {
      throw new PermissionDeniedError('The task is not awaiting apply approval.');
    }
    if (current.diff.hash !== input.reviewedDiffHash) {
      throw new PlanHashMismatchError('The apply request does not match the reviewed diff hash.');
    }
    if (
      current.workspace.baselineFingerprint === undefined ||
      current.workspace.baselineFingerprint !== input.sourceBaseline
    ) {
      throw new PlanHashMismatchError('The apply request does not match the source baseline.');
    }
    const createdAt = this.now();
    const challenge = ApprovalChallengeSchema.parse({
      schemaVersion: 1,
      id: this.newId(),
      sessionId: input.sessionId,
      purpose: 'APPLY',
      subjectHash: input.reviewedDiffHash,
      sourceBaseline: input.sourceBaseline,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + this.approvalTtlMs).toISOString(),
      status: 'PENDING',
    });
    await this.store.createApprovalChallenge(challenge);
    return {challenge, session: current.session, diff: current.diff};
  }

  public async applyApprove(
    rawInput: ApplyApproveInput,
    confirmation: TrustedConfirmation,
  ): Promise<AppliedChangesResult> {
    const input = ApplyApproveInputSchema.parse(rawInput);
    if (
      !confirmation.trusted ||
      (confirmation.source !== 'tty' && confirmation.source !== 'mcp-user-confirmation')
    ) {
      throw new PermissionDeniedError(
        'Apply approval requires a trusted, explicit user confirmation path.',
      );
    }
    if (this.execution === undefined) {
      throw new ConfigurationError('No real workspace apply engine is configured.');
    }
    const challenge = await this.store.getApprovalChallenge(input.challengeId);
    if (challenge?.status !== 'PENDING') {
      throw new PermissionDeniedError(
        'The apply approval challenge is not pending or was already used.',
      );
    }
    const current = await this.execution.currentDiff(input.sessionId);
    if (
      current.session.state !== 'AWAITING_APPLY_APPROVAL' ||
      current.diff.hash !== input.reviewedDiffHash ||
      current.workspace.baselineFingerprint !== input.sourceBaseline
    ) {
      throw new PlanHashMismatchError(
        'The current diff or source baseline changed after apply review.',
      );
    }
    const consumedAt = this.now();
    const challengeConsumption = {
      challengeId: input.challengeId,
      sessionId: input.sessionId,
      purpose: 'APPLY' as const,
      subjectHash: input.reviewedDiffHash,
      consumedAt,
    };
    const transition = this.prepareTransition(current.session, {type: 'APPLY_APPROVED'});
    await this.store.commitApplyApproval({
      challenge: challengeConsumption,
      sourceBaseline: input.sourceBaseline,
      previousSession: current.session,
      nextSession: transition.next,
      event: transition.record,
    });
    const applying = transition.next;
    return await this.execution.apply(applying, current.workspace);
  }

  public async status(rawInput: {readonly sessionId: string}): Promise<TaskSession> {
    const input = RuntimeStatusInputSchema.parse(rawInput);
    return this.requireSession(input.sessionId);
  }

  public async resume(rawInput: RuntimeResumeInput): Promise<RuntimeResumePacket> {
    const input = RuntimeResumeInputSchema.parse(rawInput);
    if (this.execution === undefined) {
      throw new ConfigurationError('No real execution engine is configured for resume.');
    }
    return await this.execution.resume(input.sessionId);
  }

  private async requireSession(sessionId: string): Promise<TaskSession> {
    const session = await this.store.getSession(sessionId);
    if (session === undefined) {
      throw new ConfigurationError(`Task session ${sessionId} was not found.`, {
        diagnostics: {sessionId},
      });
    }
    return session;
  }

  private async requirePlanRecord(taskId: string, version: number): Promise<PlanRecord> {
    const record = await this.store.getPlanRecord(taskId, version);
    if (record === undefined) {
      throw new PlanNotApprovedError(`Plan version ${String(version)} was not found.`, {
        diagnostics: {taskId, version},
      });
    }
    return record;
  }

  private async transition(session: TaskSession, event: WorkflowEvent): Promise<TaskSession> {
    const transition = this.prepareTransition(session, event);
    await this.store.commitTransition(session, transition.next, transition.record);
    return transition.next;
  }

  private prepareTransition(
    session: TaskSession,
    event: WorkflowEvent,
  ): {readonly next: TaskSession; readonly record: WorkflowEventRecord} {
    const timestamp = this.now();
    const next = transitionWorkflow(session, event, timestamp);
    const record: WorkflowEventRecord = {
      id: this.newId(),
      sessionId: session.id,
      timestamp,
      previousState: session.state,
      nextState: next.state,
      event,
    };
    return {next, record};
  }
}
