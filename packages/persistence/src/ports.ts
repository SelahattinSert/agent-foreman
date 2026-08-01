import type {
  ApprovalChallenge,
  ApprovalPurpose,
  ExecutionWorkspace,
  QualityGateReport,
  ReviewDecision,
  ReviewFinding,
  TaskPlan,
  TaskSession,
  TokenUsage,
  WorkflowEventRecord,
  WorkerExecutionResult,
} from '@agent-foreman/contracts';

export interface ConsumeApprovalChallengeInput {
  readonly challengeId: string;
  readonly sessionId: string;
  readonly purpose: ApprovalPurpose;
  readonly subjectHash: string;
  readonly consumedAt: string;
}

export interface CommitPlanApprovalInput {
  readonly challenge: ConsumeApprovalChallengeInput;
  readonly plan: TaskPlan;
  readonly markdown: string;
  readonly planHash: string;
  readonly approval: PlanApprovalRecord;
  readonly previousSession: TaskSession;
  readonly nextSession: TaskSession;
  readonly event: WorkflowEventRecord;
}

export interface CommitApplyApprovalInput {
  readonly challenge: ConsumeApprovalChallengeInput;
  readonly sourceBaseline: string;
  readonly previousSession: TaskSession;
  readonly nextSession: TaskSession;
  readonly event: WorkflowEventRecord;
}

export interface ApprovalChallengeRepository {
  createApprovalChallenge(challenge: ApprovalChallenge): Promise<void>;
  getApprovalChallenge(challengeId: string): Promise<ApprovalChallenge | undefined>;
  consumeApprovalChallenge(input: ConsumeApprovalChallengeInput): Promise<ApprovalChallenge>;
  cancelApprovalChallenge(challengeId: string, sessionId: string): Promise<void>;
  commitPlanApproval(input: CommitPlanApprovalInput): Promise<void>;
  commitApplyApproval(input: CommitApplyApprovalInput): Promise<void>;
}

export interface PlanRecord {
  readonly plan: TaskPlan;
  readonly markdown: string;
  readonly hash?: string;
}

export interface PlanApprovalRecord {
  readonly taskId: string;
  readonly planVersion: number;
  readonly hash: string;
  readonly approvedAt: string;
}

export interface ProviderExecutionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: 'supervisor' | 'worker';
  readonly providerId: string;
  readonly model?: string;
  readonly status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly providerSessionId?: string;
  readonly requestHash?: string;
  readonly result?: unknown;
  readonly errorCode?: string;
}

export interface WorkerIterationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly iteration: number;
  readonly kind: 'INITIAL' | 'MECHANICAL_REPAIR' | 'REVISION';
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly result?: WorkerExecutionResult;
  readonly diffHash?: string;
  readonly providerResponseHash?: string;
}

export interface ReviewDecisionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly iteration: number;
  readonly phase: 'SEMANTIC' | 'FINAL';
  readonly createdAt: string;
  readonly decision: ReviewDecision;
}

export interface QualityGateRunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly iteration: number;
  readonly report: QualityGateReport;
}

export interface UserDecisionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly decision: unknown;
  readonly createdAt: string;
}

export interface TokenUsageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly providerExecutionId?: string;
  readonly role: 'supervisor' | 'worker';
  readonly usage: TokenUsage;
  readonly createdAt: string;
}

export interface ResumeSnapshot {
  readonly session: TaskSession;
  readonly currentPlan?: PlanRecord;
  readonly approvedPlan?: PlanRecord;
  readonly events: readonly WorkflowEventRecord[];
  readonly openFindings: readonly ReviewFinding[];
  readonly lastProviderExecution?: ProviderExecutionRecord;
  readonly lastWorkerIteration?: WorkerIterationRecord;
  readonly lastReviewDecision?: ReviewDecisionRecord;
  readonly latestQualityGateReport?: QualityGateReport;
  readonly workerIterations: readonly WorkerIterationRecord[];
  readonly reviewDecisions: readonly ReviewDecisionRecord[];
  readonly qualityGateRuns: readonly QualityGateRunRecord[];
  readonly workspace?: ExecutionWorkspace;
}

export interface SessionRepository {
  createSession(session: TaskSession): Promise<void>;
  getSession(sessionId: string): Promise<TaskSession | undefined>;
  listSessions(limit?: number): Promise<TaskSession[]>;
  saveSession(session: TaskSession): Promise<void>;
}

export interface PlanRepository {
  savePlan(plan: TaskPlan, markdown: string, hash?: string): Promise<void>;
  getPlan(taskId: string, version: number): Promise<TaskPlan | undefined>;
  getPlanRecord(taskId: string, version: number): Promise<PlanRecord | undefined>;
  savePlanApproval(approval: PlanApprovalRecord): Promise<void>;
  getPlanApproval(taskId: string, planVersion: number): Promise<PlanApprovalRecord | undefined>;
}

export interface WorkflowEventRepository {
  listEvents(sessionId: string): Promise<WorkflowEventRecord[]>;
}

export interface WorkflowStore extends SessionRepository, PlanRepository, WorkflowEventRepository {
  commitTransition(
    previousSession: TaskSession,
    nextSession: TaskSession,
    event: WorkflowEventRecord,
  ): Promise<void>;
}

export interface AuditEventSink {
  append(event: WorkflowEventRecord): Promise<void>;
}

export interface RuntimeRecordRepository {
  recordProviderExecution(record: ProviderExecutionRecord): Promise<void>;
  recordWorkerIteration(record: WorkerIterationRecord): Promise<void>;
  recordReviewDecision(record: ReviewDecisionRecord): Promise<void>;
  recordQualityGateRun(record: QualityGateRunRecord): Promise<void>;
  recordWorkspace(sessionId: string, workspace: ExecutionWorkspace): Promise<void>;
  recordUserDecision(record: UserDecisionRecord): Promise<void>;
  recordTokenUsage(record: TokenUsageRecord): Promise<void>;
  loadResumeSnapshot(sessionId: string): Promise<ResumeSnapshot | undefined>;
}
