import {
  ApprovalChallengeSchema,
  ExecutionWorkspaceSchema,
  ReviewDecisionSchema,
  TaskPlanSchema,
  TaskSessionSchema,
  WorkflowEventRecordSchema,
  type ApprovalChallenge,
  type ExecutionWorkspace,
  type ReviewFinding,
  type TaskPlan,
  type TaskSession,
  type WorkflowEventRecord,
} from '@agent-foreman/contracts';

import {PermissionDeniedError, PersistenceError} from '@agent-foreman/core';

import type {
  ApprovalChallengeRepository,
  CommitApplyApprovalInput,
  CommitPlanApprovalInput,
  ConsumeApprovalChallengeInput,
  PlanApprovalRecord,
  PlanRecord,
  ProviderExecutionRecord,
  QualityGateRunRecord,
  ResumeSnapshot,
  ReviewDecisionRecord,
  RuntimeRecordRepository,
  TokenUsageRecord,
  UserDecisionRecord,
  WorkerIterationRecord,
  WorkflowStore,
} from '../ports.js';

const planKey = (taskId: string, version: number): string => `${taskId}:${String(version)}`;

export class InMemoryWorkflowStore
  implements WorkflowStore, ApprovalChallengeRepository, RuntimeRecordRepository
{
  private readonly sessions = new Map<string, TaskSession>();
  private readonly plans = new Map<string, TaskPlan>();
  private readonly events = new Map<string, WorkflowEventRecord[]>();
  private readonly planRecords = new Map<string, PlanRecord>();
  private readonly approvals = new Map<string, PlanApprovalRecord>();
  private readonly approvalChallenges = new Map<string, ApprovalChallenge>();
  private readonly providerExecutions: ProviderExecutionRecord[] = [];
  private readonly workerIterations: WorkerIterationRecord[] = [];
  private readonly reviewDecisions: ReviewDecisionRecord[] = [];
  private readonly qualityGateRuns: QualityGateRunRecord[] = [];
  private readonly workspaces = new Map<string, ExecutionWorkspace>();
  private readonly userDecisions: UserDecisionRecord[] = [];
  private readonly tokenUsage: TokenUsageRecord[] = [];
  private readonly openFindings = new Map<string, Map<string, ReviewFinding>>();

  public async createSession(rawSession: TaskSession): Promise<void> {
    const session = TaskSessionSchema.parse(rawSession);
    if (this.sessions.has(session.id)) throw new Error(`Session ${session.id} already exists.`);
    this.sessions.set(session.id, structuredClone(session));
  }

  public async getSession(sessionId: string): Promise<TaskSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  public async listSessions(limit = 50): Promise<TaskSession[]> {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((session) => structuredClone(session));
  }

  public async saveSession(rawSession: TaskSession): Promise<void> {
    const session = TaskSessionSchema.parse(rawSession);
    this.sessions.set(session.id, structuredClone(session));
  }

  public async savePlan(rawPlan: TaskPlan, _markdown: string, _hash?: string): Promise<void> {
    const plan = TaskPlanSchema.parse(rawPlan);
    this.plans.set(planKey(plan.taskId, plan.version), structuredClone(plan));
    this.planRecords.set(planKey(plan.taskId, plan.version), {
      plan: structuredClone(plan),
      markdown: _markdown,
      ...(_hash === undefined ? {} : {hash: _hash}),
    });
  }

  public async getPlanRecord(taskId: string, version: number): Promise<PlanRecord | undefined> {
    const record = this.planRecords.get(planKey(taskId, version));
    return record === undefined ? undefined : structuredClone(record);
  }

  public async savePlanApproval(approval: PlanApprovalRecord): Promise<void> {
    this.approvals.set(planKey(approval.taskId, approval.planVersion), structuredClone(approval));
  }

  public async getPlanApproval(
    taskId: string,
    planVersion: number,
  ): Promise<PlanApprovalRecord | undefined> {
    const approval = this.approvals.get(planKey(taskId, planVersion));
    return approval === undefined ? undefined : structuredClone(approval);
  }

  public async createApprovalChallenge(rawChallenge: ApprovalChallenge): Promise<void> {
    const challenge = ApprovalChallengeSchema.parse(rawChallenge);
    if (challenge.status !== 'PENDING') {
      throw new PersistenceError('A new approval challenge must be pending.');
    }
    for (const [id, existing] of this.approvalChallenges) {
      if (
        existing.sessionId === challenge.sessionId &&
        existing.purpose === challenge.purpose &&
        existing.status === 'PENDING'
      ) {
        this.approvalChallenges.set(id, {
          ...existing,
          status: existing.expiresAt <= challenge.createdAt ? 'EXPIRED' : 'CANCELLED',
        });
      }
    }
    if (this.approvalChallenges.has(challenge.id)) {
      throw new PersistenceError(`Approval challenge ${challenge.id} already exists.`);
    }
    this.approvalChallenges.set(challenge.id, structuredClone(challenge));
  }

  public async getApprovalChallenge(challengeId: string): Promise<ApprovalChallenge | undefined> {
    const challenge = this.approvalChallenges.get(challengeId);
    return challenge === undefined ? undefined : structuredClone(challenge);
  }

  public async consumeApprovalChallenge(
    input: ConsumeApprovalChallengeInput,
  ): Promise<ApprovalChallenge> {
    const challenge = this.approvalChallenges.get(input.challengeId);
    if (
      challenge?.sessionId !== input.sessionId ||
      challenge.purpose !== input.purpose ||
      challenge.subjectHash !== input.subjectHash
    ) {
      throw new PermissionDeniedError(
        'The approval authorization does not match this session, purpose, or hash.',
      );
    }
    if (challenge.status !== 'PENDING') {
      throw new PermissionDeniedError('The approval challenge is not pending or was already used.');
    }
    if (challenge.expiresAt <= input.consumedAt) {
      this.approvalChallenges.set(challenge.id, {...challenge, status: 'EXPIRED'});
      throw new PermissionDeniedError('The approval challenge has expired.');
    }
    const consumed: ApprovalChallenge = {
      ...challenge,
      status: 'CONSUMED',
      consumedAt: input.consumedAt,
    };
    this.approvalChallenges.set(challenge.id, consumed);
    return structuredClone(consumed);
  }

  public async cancelApprovalChallenge(challengeId: string, sessionId: string): Promise<void> {
    const challenge = this.approvalChallenges.get(challengeId);
    if (challenge?.sessionId !== sessionId || challenge.status !== 'PENDING') {
      throw new PermissionDeniedError('The approval challenge cannot be cancelled.');
    }
    this.approvalChallenges.set(challengeId, {...challenge, status: 'CANCELLED'});
  }

  public async commitPlanApproval(input: CommitPlanApprovalInput): Promise<void> {
    const plan = TaskPlanSchema.parse(input.plan);
    const previous = TaskSessionSchema.parse(input.previousSession);
    const next = TaskSessionSchema.parse(input.nextSession);
    const event = WorkflowEventRecordSchema.parse(input.event);
    const challenge = this.requireAtomicChallenge(input.challenge, plan.version);
    const currentPlan = this.planRecords.get(planKey(plan.taskId, plan.version));
    if (
      input.challenge.purpose !== 'PLAN' ||
      currentPlan?.plan.status !== 'DRAFT' ||
      plan.status !== 'APPROVED' ||
      plan.taskId !== previous.id ||
      input.approval.taskId !== previous.id ||
      input.approval.planVersion !== plan.version ||
      input.approval.hash !== input.planHash ||
      input.approval.approvedAt !== plan.approvedAt
    ) {
      throw new PersistenceError('Plan approval transaction payload is inconsistent.');
    }
    this.assertTransition(previous, next, event);
    this.approvalChallenges.set(challenge.id, {
      ...challenge,
      status: 'CONSUMED',
      consumedAt: input.challenge.consumedAt,
    });
    this.plans.set(planKey(plan.taskId, plan.version), structuredClone(plan));
    this.planRecords.set(planKey(plan.taskId, plan.version), {
      plan: structuredClone(plan),
      markdown: input.markdown,
      hash: input.planHash,
    });
    this.approvals.set(
      planKey(input.approval.taskId, input.approval.planVersion),
      structuredClone(input.approval),
    );
    this.sessions.set(previous.id, structuredClone(next));
    this.events.set(previous.id, [...(this.events.get(previous.id) ?? []), structuredClone(event)]);
  }

  public async commitApplyApproval(input: CommitApplyApprovalInput): Promise<void> {
    const previous = TaskSessionSchema.parse(input.previousSession);
    const next = TaskSessionSchema.parse(input.nextSession);
    const event = WorkflowEventRecordSchema.parse(input.event);
    const challenge = this.requireAtomicChallenge(input.challenge, undefined, input.sourceBaseline);
    if (input.challenge.purpose !== 'APPLY') {
      throw new PersistenceError('Apply approval transaction payload is inconsistent.');
    }
    this.assertTransition(previous, next, event);
    this.approvalChallenges.set(challenge.id, {
      ...challenge,
      status: 'CONSUMED',
      consumedAt: input.challenge.consumedAt,
    });
    this.sessions.set(previous.id, structuredClone(next));
    this.events.set(previous.id, [...(this.events.get(previous.id) ?? []), structuredClone(event)]);
  }

  public async getPlan(taskId: string, version: number): Promise<TaskPlan | undefined> {
    const plan = this.plans.get(planKey(taskId, version));
    return plan === undefined ? undefined : structuredClone(plan);
  }

  public async listEvents(sessionId: string): Promise<WorkflowEventRecord[]> {
    return structuredClone(this.events.get(sessionId) ?? []);
  }

  public async commitTransition(
    rawPrevious: TaskSession,
    rawNext: TaskSession,
    rawEvent: WorkflowEventRecord,
  ): Promise<void> {
    const previous = TaskSessionSchema.parse(rawPrevious);
    const next = TaskSessionSchema.parse(rawNext);
    const event = WorkflowEventRecordSchema.parse(rawEvent);
    const current = this.sessions.get(previous.id);
    if (current?.state !== previous.state || current.updatedAt !== previous.updatedAt) {
      throw new Error(`Cannot commit stale transition for session ${previous.id}.`);
    }
    if (
      next.id !== previous.id ||
      event.sessionId !== previous.id ||
      event.previousState !== previous.state ||
      event.nextState !== next.state
    ) {
      throw new Error(`Transition payload is inconsistent for session ${previous.id}.`);
    }

    const nextEvents = [...(this.events.get(previous.id) ?? []), structuredClone(event)];
    this.sessions.set(previous.id, structuredClone(next));
    this.events.set(previous.id, nextEvents);
  }

  public async recordProviderExecution(record: ProviderExecutionRecord): Promise<void> {
    const index = this.providerExecutions.findIndex(({id}) => id === record.id);
    if (index === -1) this.providerExecutions.push(structuredClone(record));
    else this.providerExecutions[index] = structuredClone(record);
  }

  public async recordWorkerIteration(record: WorkerIterationRecord): Promise<void> {
    const index = this.workerIterations.findIndex(({id}) => id === record.id);
    if (index === -1) this.workerIterations.push(structuredClone(record));
    else this.workerIterations[index] = structuredClone(record);
  }

  public async recordReviewDecision(record: ReviewDecisionRecord): Promise<void> {
    const decision = ReviewDecisionSchema.parse(record.decision);
    this.reviewDecisions.push(structuredClone({...record, decision}));
    const findings = this.openFindings.get(record.sessionId) ?? new Map<string, ReviewFinding>();
    for (const finding of decision.findings) {
      if (decision.openFindingIds.includes(finding.id)) findings.set(finding.id, finding);
      else findings.delete(finding.id);
    }
    this.openFindings.set(record.sessionId, findings);
  }

  public async recordQualityGateRun(record: QualityGateRunRecord): Promise<void> {
    this.qualityGateRuns.push(structuredClone(record));
  }

  public async recordWorkspace(sessionId: string, workspace: ExecutionWorkspace): Promise<void> {
    this.workspaces.set(sessionId, ExecutionWorkspaceSchema.parse(workspace));
  }

  public async recordUserDecision(record: UserDecisionRecord): Promise<void> {
    this.userDecisions.push(structuredClone(record));
  }

  public async recordTokenUsage(record: TokenUsageRecord): Promise<void> {
    this.tokenUsage.push(structuredClone(record));
  }

  public async loadResumeSnapshot(sessionId: string): Promise<ResumeSnapshot | undefined> {
    const session = await this.getSession(sessionId);
    if (session === undefined) return undefined;
    const byLatest = <T>(values: readonly T[], timestamp: (value: T) => string): T | undefined =>
      values.reduce<T | undefined>((latest, value) => {
        if (latest === undefined || timestamp(value) >= timestamp(latest)) return value;
        return latest;
      }, undefined);
    const currentPlan =
      session.currentPlanVersion === undefined
        ? undefined
        : await this.getPlanRecord(sessionId, session.currentPlanVersion);
    const approvedPlan =
      session.approvedPlanVersion === undefined
        ? undefined
        : await this.getPlanRecord(sessionId, session.approvedPlanVersion);
    const lastProviderExecution = byLatest(
      this.providerExecutions.filter((record) => record.sessionId === sessionId),
      ({startedAt}) => startedAt,
    );
    const lastWorkerIteration = byLatest(
      this.workerIterations.filter((record) => record.sessionId === sessionId),
      ({startedAt}) => startedAt,
    );
    const lastReviewDecision = byLatest(
      this.reviewDecisions.filter((record) => record.sessionId === sessionId),
      ({createdAt}) => createdAt,
    );
    const latestGate = byLatest(
      this.qualityGateRuns.filter((record) => record.sessionId === sessionId),
      ({report}) => report.completedAt,
    );
    const workspace = this.workspaces.get(sessionId) ?? session.workspace;
    const workerIterations = this.workerIterations
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const reviewDecisions = this.reviewDecisions
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const qualityGateRuns = this.qualityGateRuns
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.report.startedAt.localeCompare(right.report.startedAt));
    const resumedSession =
      workspace === undefined ? session : TaskSessionSchema.parse({...session, workspace});
    return {
      session: structuredClone(resumedSession),
      ...(currentPlan === undefined ? {} : {currentPlan}),
      ...(approvedPlan === undefined ? {} : {approvedPlan}),
      events: await this.listEvents(sessionId),
      openFindings: structuredClone([...(this.openFindings.get(sessionId)?.values() ?? [])]),
      ...(lastProviderExecution === undefined
        ? {}
        : {lastProviderExecution: structuredClone(lastProviderExecution)}),
      ...(lastWorkerIteration === undefined
        ? {}
        : {lastWorkerIteration: structuredClone(lastWorkerIteration)}),
      ...(lastReviewDecision === undefined
        ? {}
        : {lastReviewDecision: structuredClone(lastReviewDecision)}),
      ...(latestGate === undefined
        ? {}
        : {latestQualityGateReport: structuredClone(latestGate.report)}),
      workerIterations: structuredClone(workerIterations),
      reviewDecisions: structuredClone(reviewDecisions),
      qualityGateRuns: structuredClone(qualityGateRuns),
      ...(workspace === undefined ? {} : {workspace: structuredClone(workspace)}),
    };
  }

  private requireAtomicChallenge(
    input: ConsumeApprovalChallengeInput,
    planVersion?: number,
    sourceBaseline?: string,
  ): ApprovalChallenge {
    const challenge = this.approvalChallenges.get(input.challengeId);
    if (
      challenge?.sessionId !== input.sessionId ||
      challenge.purpose !== input.purpose ||
      challenge.subjectHash !== input.subjectHash ||
      (planVersion !== undefined && challenge.planVersion !== planVersion) ||
      (sourceBaseline !== undefined && challenge.sourceBaseline !== sourceBaseline)
    ) {
      throw new PermissionDeniedError(
        'The approval authorization does not match this session, purpose, or hash.',
      );
    }
    if (challenge.status !== 'PENDING') {
      throw new PermissionDeniedError('The approval challenge is not pending or was already used.');
    }
    if (challenge.expiresAt <= input.consumedAt) {
      this.approvalChallenges.set(challenge.id, {...challenge, status: 'EXPIRED'});
      throw new PermissionDeniedError('The approval challenge has expired.');
    }
    return challenge;
  }

  private assertTransition(
    previous: TaskSession,
    next: TaskSession,
    event: WorkflowEventRecord,
  ): void {
    const current = this.sessions.get(previous.id);
    if (current?.state !== previous.state || current.updatedAt !== previous.updatedAt) {
      throw new PersistenceError(`Cannot commit stale transition for session ${previous.id}.`);
    }
    if (
      next.id !== previous.id ||
      event.sessionId !== previous.id ||
      event.previousState !== previous.state ||
      event.nextState !== next.state
    ) {
      throw new PersistenceError(`Transition payload is inconsistent for session ${previous.id}.`);
    }
  }
}
