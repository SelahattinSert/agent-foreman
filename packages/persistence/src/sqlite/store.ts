import {mkdir} from 'node:fs/promises';
import path from 'node:path';

/* eslint-disable @typescript-eslint/require-await -- The async repository port is backed by a synchronous transactional SQLite driver. */

import Database from 'better-sqlite3';

import {
  ApprovalChallengeSchema,
  ExecutionWorkspaceSchema,
  QualityGateReportSchema,
  ReviewDecisionSchema,
  ReviewFindingSchema,
  TaskPlanSchema,
  TaskSessionSchema,
  TokenUsageSchema,
  WorkflowEventRecordSchema,
  WorkerExecutionResultSchema,
  type ApprovalChallenge,
  type ExecutionWorkspace,
  type TaskPlan,
  type TaskSession,
  type WorkflowEventRecord,
} from '@agent-foreman/contracts';
import {PermissionDeniedError, PersistenceError} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';

import {JsonlAuditLog} from '../jsonl/audit-log.js';
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
import {runMigrations} from './migrations.js';

export interface SqliteWorkflowStoreOptions {
  readonly databasePath: string;
  readonly auditLogPath?: string;
}

interface SessionRow {
  readonly session_json: string;
}
interface PlanRow {
  readonly plan_json: string;
  readonly markdown: string;
  readonly plan_hash: string | null;
}
interface EventRow {
  readonly event_json: string;
}
interface JsonRow {
  readonly value: string;
}
interface ProviderExecutionRow {
  readonly id: string;
  readonly session_id: string;
  readonly role: 'supervisor' | 'worker';
  readonly provider_id: string;
  readonly model: string | null;
  readonly status: ProviderExecutionRecord['status'];
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly provider_session_id: string | null;
  readonly request_hash: string | null;
  readonly result_json: string | null;
  readonly error_code: string | null;
}
interface WorkerIterationRow {
  readonly id: string;
  readonly session_id: string;
  readonly iteration: number;
  readonly kind: WorkerIterationRecord['kind'];
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly result_json: string | null;
  readonly diff_hash: string | null;
  readonly provider_response_hash: string | null;
}
interface ReviewDecisionRow {
  readonly id: string;
  readonly session_id: string;
  readonly iteration: number;
  readonly phase: ReviewDecisionRecord['phase'];
  readonly created_at: string;
  readonly decision_json: string;
}
interface QualityGateRunRow {
  readonly id: string;
  readonly session_id: string;
  readonly iteration: number;
  readonly report_json: string;
}
interface ApprovalChallengeRow {
  readonly id: string;
  readonly session_id: string;
  readonly purpose: ApprovalChallenge['purpose'];
  readonly subject_hash: string;
  readonly plan_version: number | null;
  readonly source_baseline: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly status: ApprovalChallenge['status'];
  readonly consumed_at: string | null;
}
interface PlanApprovalRow {
  readonly task_id: string;
  readonly plan_version: number;
  readonly plan_hash: string;
  readonly approved_at: string;
}

type ChallengeFailure = 'expired' | 'mismatch' | 'not-pending';

const challengeFailure = (
  error: ChallengeFailure,
  input: ConsumeApprovalChallengeInput,
): InstanceType<typeof PermissionDeniedError> =>
  new PermissionDeniedError(
    error === 'expired'
      ? 'The approval challenge has expired.'
      : error === 'not-pending'
        ? 'The approval challenge is not pending or was already used.'
        : 'The approval authorization does not match this session, purpose, or hash.',
    {diagnostics: {challengeId: input.challengeId, purpose: input.purpose}},
  );

const json = (value: unknown): string => JSON.stringify(value);
const parseUnknown = (value: string): unknown => JSON.parse(value) as unknown;
const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): Partial<Record<K, V>> => {
  const result: Partial<Record<K, V>> = {};
  if (value !== null && value !== undefined) result[key] = value;
  return result;
};

export class SqliteWorkflowStore
  implements WorkflowStore, RuntimeRecordRepository, ApprovalChallengeRepository
{
  private readonly auditLog: JsonlAuditLog | undefined;

  private constructor(
    private readonly database: Database.Database,
    auditLogPath: string | undefined,
  ) {
    this.auditLog = auditLogPath === undefined ? undefined : new JsonlAuditLog(auditLogPath);
  }

  public static async open(options: SqliteWorkflowStoreOptions): Promise<SqliteWorkflowStore> {
    if (options.databasePath !== ':memory:') {
      await mkdir(path.dirname(path.resolve(options.databasePath)), {recursive: true, mode: 0o700});
    }
    const database = new Database(options.databasePath);
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (options.databasePath !== ':memory:') database.pragma('journal_mode = WAL');
    runMigrations(database);
    const store = new SqliteWorkflowStore(database, options.auditLogPath);
    await store.reconcileAuditLog();
    return store;
  }

  public close(): void {
    this.database.close();
  }

  public async listTables(): Promise<readonly string[]> {
    const rows = this.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as readonly {name: string}[];
    return rows.map((row) => row.name);
  }

  public async createSession(rawSession: TaskSession): Promise<void> {
    const session = TaskSessionSchema.parse(rawSession);
    try {
      this.database
        .prepare(
          'INSERT INTO sessions(id, created_at, updated_at, state, session_json) VALUES (?, ?, ?, ?, ?)',
        )
        .run(session.id, session.createdAt, session.updatedAt, session.state, json(session));
    } catch (cause: unknown) {
      throw new PersistenceError(`Could not create session ${session.id}.`, {cause});
    }
  }

  public async getSession(sessionId: string): Promise<TaskSession | undefined> {
    const row = this.database
      .prepare('SELECT session_json FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : TaskSessionSchema.parse(parseUnknown(row.session_json));
  }

  public async listSessions(limit = 50): Promise<TaskSession[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new PersistenceError('Session list limit must be between 1 and 1000.');
    }
    const rows = this.database
      .prepare('SELECT session_json FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(limit) as readonly SessionRow[];
    return rows.map((row) => TaskSessionSchema.parse(parseUnknown(row.session_json)));
  }

  public async saveSession(rawSession: TaskSession): Promise<void> {
    const session = TaskSessionSchema.parse(rawSession);
    this.database
      .prepare(
        `INSERT INTO sessions(id, created_at, updated_at, state, session_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at=excluded.updated_at, state=excluded.state, session_json=excluded.session_json`,
      )
      .run(session.id, session.createdAt, session.updatedAt, session.state, json(session));
  }

  public async savePlan(rawPlan: TaskPlan, markdown: string, hash?: string): Promise<void> {
    const plan = TaskPlanSchema.parse(rawPlan);
    const existing = await this.getPlanRecord(plan.taskId, plan.version);
    if (existing?.plan.status === 'APPROVED' && json(existing.plan) !== json(plan)) {
      throw new PersistenceError('An approved plan version is immutable.', {
        diagnostics: {taskId: plan.taskId, version: plan.version},
      });
    }
    this.database
      .prepare(
        `INSERT INTO plans(task_id, version, status, plan_hash, markdown, plan_json, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, version) DO UPDATE SET
           status=excluded.status, plan_hash=excluded.plan_hash, markdown=excluded.markdown,
           plan_json=excluded.plan_json, approved_at=excluded.approved_at`,
      )
      .run(
        plan.taskId,
        plan.version,
        plan.status,
        hash ?? null,
        markdown,
        json(plan),
        plan.createdAt,
        plan.approvedAt ?? null,
      );
  }

  public async getPlan(taskId: string, version: number): Promise<TaskPlan | undefined> {
    return (await this.getPlanRecord(taskId, version))?.plan;
  }

  public async getPlanRecord(taskId: string, version: number): Promise<PlanRecord | undefined> {
    const row = this.database
      .prepare('SELECT plan_json, markdown, plan_hash FROM plans WHERE task_id = ? AND version = ?')
      .get(taskId, version) as PlanRow | undefined;
    if (row === undefined) return undefined;
    return {
      plan: TaskPlanSchema.parse(parseUnknown(row.plan_json)),
      markdown: row.markdown,
      ...optional('hash', row.plan_hash),
    };
  }

  public async savePlanApproval(approval: PlanApprovalRecord): Promise<void> {
    const planRecord = await this.getPlanRecord(approval.taskId, approval.planVersion);
    if (
      planRecord?.plan.status !== 'APPROVED' ||
      planRecord.plan.approvedAt !== approval.approvedAt ||
      planRecord.hash !== approval.hash
    ) {
      throw new PersistenceError('Plan approval does not match the frozen plan record.', {
        diagnostics: {taskId: approval.taskId, planVersion: approval.planVersion},
      });
    }
    const existing = this.database
      .prepare(
        'SELECT plan_hash, approved_at FROM plan_approvals WHERE task_id = ? AND plan_version = ?',
      )
      .get(approval.taskId, approval.planVersion) as
      {plan_hash: string; approved_at: string} | undefined;
    if (existing !== undefined) {
      if (existing.plan_hash === approval.hash && existing.approved_at === approval.approvedAt)
        return;
      throw new PersistenceError('A different immutable approval already exists for this plan.');
    }
    this.database
      .prepare(
        'INSERT INTO plan_approvals(task_id, plan_version, plan_hash, approved_at) VALUES (?, ?, ?, ?)',
      )
      .run(approval.taskId, approval.planVersion, approval.hash, approval.approvedAt);
  }

  public async getPlanApproval(
    taskId: string,
    planVersion: number,
  ): Promise<PlanApprovalRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT task_id, plan_version, plan_hash, approved_at
         FROM plan_approvals WHERE task_id = ? AND plan_version = ?`,
      )
      .get(taskId, planVersion) as PlanApprovalRow | undefined;
    if (row === undefined) return undefined;
    return {
      taskId: row.task_id,
      planVersion: row.plan_version,
      hash: row.plan_hash,
      approvedAt: row.approved_at,
    };
  }

  public async createApprovalChallenge(rawChallenge: ApprovalChallenge): Promise<void> {
    const challenge = ApprovalChallengeSchema.parse(rawChallenge);
    if (challenge.status !== 'PENDING') {
      throw new PersistenceError('A new approval challenge must be pending.');
    }
    const transaction = this.database.transaction((): void => {
      this.database
        .prepare(
          `UPDATE approval_challenges
           SET status = CASE WHEN expires_at <= ? THEN 'EXPIRED' ELSE 'CANCELLED' END
           WHERE session_id = ? AND purpose = ? AND status = 'PENDING'`,
        )
        .run(challenge.createdAt, challenge.sessionId, challenge.purpose);
      this.database
        .prepare(
          `INSERT INTO approval_challenges(
             id, session_id, purpose, subject_hash, plan_version, source_baseline,
             created_at, expires_at, status, consumed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          challenge.id,
          challenge.sessionId,
          challenge.purpose,
          challenge.subjectHash,
          challenge.planVersion ?? null,
          challenge.sourceBaseline ?? null,
          challenge.createdAt,
          challenge.expiresAt,
          challenge.status,
          challenge.consumedAt ?? null,
        );
    });
    try {
      transaction.immediate();
    } catch (cause: unknown) {
      throw new PersistenceError('Could not create the approval challenge.', {cause});
    }
  }

  public async getApprovalChallenge(challengeId: string): Promise<ApprovalChallenge | undefined> {
    const row = this.database
      .prepare('SELECT * FROM approval_challenges WHERE id = ?')
      .get(challengeId) as ApprovalChallengeRow | undefined;
    return row === undefined ? undefined : this.approvalChallengeFromRow(row);
  }

  public async consumeApprovalChallenge(
    input: ConsumeApprovalChallengeInput,
  ): Promise<ApprovalChallenge> {
    type ConsumptionResult =
      | {readonly challenge: ApprovalChallenge}
      | {readonly error: 'expired' | 'mismatch' | 'not-pending'};
    const transaction = this.database.transaction((): ConsumptionResult => {
      const row = this.database
        .prepare('SELECT * FROM approval_challenges WHERE id = ?')
        .get(input.challengeId) as ApprovalChallengeRow | undefined;
      if (
        row?.session_id !== input.sessionId ||
        row.purpose !== input.purpose ||
        row.subject_hash !== input.subjectHash
      ) {
        return {error: 'mismatch'};
      }
      if (row.status !== 'PENDING') return {error: 'not-pending'};
      if (row.expires_at <= input.consumedAt) {
        this.database
          .prepare("UPDATE approval_challenges SET status = 'EXPIRED' WHERE id = ?")
          .run(input.challengeId);
        return {error: 'expired'};
      }
      const update = this.database
        .prepare(
          `UPDATE approval_challenges SET status = 'CONSUMED', consumed_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(input.consumedAt, input.challengeId);
      if (update.changes !== 1) return {error: 'not-pending'};
      const consumed = this.database
        .prepare('SELECT * FROM approval_challenges WHERE id = ?')
        .get(input.challengeId) as ApprovalChallengeRow;
      return {challenge: this.approvalChallengeFromRow(consumed)};
    });
    const result = transaction.immediate();
    if ('challenge' in result) return result.challenge;
    const message =
      result.error === 'expired'
        ? 'The approval challenge has expired.'
        : result.error === 'not-pending'
          ? 'The approval challenge is not pending or was already used.'
          : 'The approval authorization does not match this session, purpose, or hash.';
    throw new PermissionDeniedError(message, {
      diagnostics: {challengeId: input.challengeId, purpose: input.purpose},
    });
  }

  public async cancelApprovalChallenge(challengeId: string, sessionId: string): Promise<void> {
    const result = this.database
      .prepare(
        `UPDATE approval_challenges SET status = 'CANCELLED'
         WHERE id = ? AND session_id = ? AND status = 'PENDING'`,
      )
      .run(challengeId, sessionId);
    if (result.changes !== 1) {
      throw new PermissionDeniedError('The approval challenge cannot be cancelled.', {
        diagnostics: {challengeId, sessionId},
      });
    }
  }

  public async commitPlanApproval(input: CommitPlanApprovalInput): Promise<void> {
    const plan = TaskPlanSchema.parse(input.plan);
    const previous = TaskSessionSchema.parse(input.previousSession);
    const next = TaskSessionSchema.parse(input.nextSession);
    const event = WorkflowEventRecordSchema.parse(redactValue(input.event));
    if (
      input.challenge.purpose !== 'PLAN' ||
      plan.status !== 'APPROVED' ||
      plan.taskId !== previous.id ||
      input.approval.taskId !== previous.id ||
      input.approval.planVersion !== plan.version ||
      input.approval.hash !== input.planHash ||
      input.approval.approvedAt !== plan.approvedAt
    ) {
      throw new PersistenceError('Plan approval transaction payload is inconsistent.');
    }
    const transaction = this.database.transaction((): ChallengeFailure | undefined => {
      const challenge = this.challengeFailureWithinTransaction(input.challenge, plan.version);
      if (challenge !== undefined) return challenge;
      const existing = this.database
        .prepare('SELECT plan_json FROM plans WHERE task_id = ? AND version = ?')
        .get(plan.taskId, plan.version) as {plan_json: string} | undefined;
      if (existing === undefined) {
        throw new PersistenceError('The draft plan no longer exists.');
      }
      const existingPlan = TaskPlanSchema.parse(parseUnknown(existing.plan_json));
      if (existingPlan.status !== 'DRAFT') {
        throw new PersistenceError('Only a draft plan may be frozen.');
      }
      this.database
        .prepare(
          `UPDATE plans SET status = ?, plan_hash = ?, markdown = ?, plan_json = ?, approved_at = ?
           WHERE task_id = ? AND version = ?`,
        )
        .run(
          plan.status,
          input.planHash,
          input.markdown,
          json(plan),
          plan.approvedAt ?? null,
          plan.taskId,
          plan.version,
        );
      this.database
        .prepare(
          'INSERT INTO plan_approvals(task_id, plan_version, plan_hash, approved_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          input.approval.taskId,
          input.approval.planVersion,
          input.approval.hash,
          input.approval.approvedAt,
        );
      this.writeTransitionRows(previous, next, event);
      return undefined;
    });
    const failure = transaction.immediate();
    if (failure !== undefined) throw challengeFailure(failure, input.challenge);
    await this.reconcileAuditLog();
  }

  public async commitApplyApproval(input: CommitApplyApprovalInput): Promise<void> {
    const previous = TaskSessionSchema.parse(input.previousSession);
    const next = TaskSessionSchema.parse(input.nextSession);
    const event = WorkflowEventRecordSchema.parse(redactValue(input.event));
    if (input.challenge.purpose !== 'APPLY') {
      throw new PersistenceError('Apply approval transaction payload is inconsistent.');
    }
    const transaction = this.database.transaction((): ChallengeFailure | undefined => {
      const failure = this.challengeFailureWithinTransaction(
        input.challenge,
        undefined,
        input.sourceBaseline,
      );
      if (failure !== undefined) return failure;
      this.writeTransitionRows(previous, next, event);
      return undefined;
    });
    const failure = transaction.immediate();
    if (failure !== undefined) throw challengeFailure(failure, input.challenge);
    await this.reconcileAuditLog();
  }

  public async listEvents(sessionId: string): Promise<WorkflowEventRecord[]> {
    const rows = this.database
      .prepare(
        'SELECT event_json FROM workflow_events WHERE session_id = ? ORDER BY timestamp, rowid',
      )
      .all(sessionId) as readonly EventRow[];
    return rows.map((row) => WorkflowEventRecordSchema.parse(parseUnknown(row.event_json)));
  }

  public async commitTransition(
    rawPrevious: TaskSession,
    rawNext: TaskSession,
    rawEvent: WorkflowEventRecord,
  ): Promise<void> {
    const previous = TaskSessionSchema.parse(rawPrevious);
    const next = TaskSessionSchema.parse(rawNext);
    const event = WorkflowEventRecordSchema.parse(redactValue(rawEvent));
    const transaction = this.database.transaction((): void => {
      const current = this.database
        .prepare('SELECT state, updated_at FROM sessions WHERE id = ?')
        .get(previous.id) as {state: string; updated_at: string} | undefined;
      if (current?.state !== previous.state || current.updated_at !== previous.updatedAt) {
        throw new PersistenceError(`Cannot commit stale transition for session ${previous.id}.`);
      }
      if (
        next.id !== previous.id ||
        event.sessionId !== previous.id ||
        event.previousState !== previous.state ||
        event.nextState !== next.state
      ) {
        throw new PersistenceError(
          `Transition payload is inconsistent for session ${previous.id}.`,
        );
      }
      this.database
        .prepare('UPDATE sessions SET updated_at = ?, state = ?, session_json = ? WHERE id = ?')
        .run(next.updatedAt, next.state, json(next), next.id);
      this.database
        .prepare(
          `INSERT INTO workflow_events(
             id, session_id, timestamp, previous_state, next_state, event_type, event_json, audit_exported
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.sessionId,
          event.timestamp,
          event.previousState,
          event.nextState,
          event.event.type,
          json(event),
          this.auditLog === undefined ? 1 : 0,
        );
    });
    transaction.immediate();
    await this.reconcileAuditLog();
  }

  public async recordProviderExecution(record: ProviderExecutionRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO provider_executions(
           id, session_id, role, provider_id, model, status, started_at, completed_at,
           provider_session_id, request_hash, result_json, error_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status, completed_at=excluded.completed_at,
           provider_session_id=excluded.provider_session_id, result_json=excluded.result_json,
           error_code=excluded.error_code`,
      )
      .run(
        record.id,
        record.sessionId,
        record.role,
        record.providerId,
        record.model ?? null,
        record.status,
        record.startedAt,
        record.completedAt ?? null,
        record.providerSessionId ?? null,
        record.requestHash ?? null,
        record.result === undefined ? null : json(redactValue(record.result)),
        record.errorCode ?? null,
      );
  }

  public async recordWorkerIteration(record: WorkerIterationRecord): Promise<void> {
    const result =
      record.result === undefined ? undefined : WorkerExecutionResultSchema.parse(record.result);
    this.database
      .prepare(
        `INSERT INTO worker_iterations(
           id, session_id, iteration, kind, started_at, completed_at,
           result_json, diff_hash, provider_response_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           completed_at=excluded.completed_at, result_json=excluded.result_json,
           diff_hash=excluded.diff_hash, provider_response_hash=excluded.provider_response_hash`,
      )
      .run(
        record.id,
        record.sessionId,
        record.iteration,
        record.kind,
        record.startedAt,
        record.completedAt ?? null,
        result === undefined ? null : json(result),
        record.diffHash ?? null,
        record.providerResponseHash ?? null,
      );
  }

  public async recordReviewDecision(record: ReviewDecisionRecord): Promise<void> {
    const decision = ReviewDecisionSchema.parse(record.decision);
    const transaction = this.database.transaction((): void => {
      this.database
        .prepare(
          `INSERT INTO review_decisions(id, session_id, iteration, phase, verdict, created_at, decision_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sessionId,
          record.iteration,
          record.phase,
          decision.verdict,
          record.createdAt,
          json(decision),
        );
      for (const finding of decision.findings) {
        const status = decision.resolvedFindingIds.includes(finding.id) ? 'RESOLVED' : 'OPEN';
        this.database
          .prepare(
            `INSERT INTO review_findings(
               session_id, finding_id, status, severity, first_seen_iteration,
               last_seen_iteration, occurrences, finding_json
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(session_id, finding_id) DO UPDATE SET
               status=excluded.status, severity=excluded.severity,
               last_seen_iteration=excluded.last_seen_iteration,
               occurrences=review_findings.occurrences + 1,
               finding_json=excluded.finding_json`,
          )
          .run(
            record.sessionId,
            finding.id,
            status,
            finding.severity,
            record.iteration,
            record.iteration,
            json(finding),
          );
      }
    });
    transaction.immediate();
  }

  public async recordQualityGateRun(record: QualityGateRunRecord): Promise<void> {
    const report = QualityGateReportSchema.parse(record.report);
    this.database
      .prepare(
        `INSERT INTO quality_gate_runs(
           id, session_id, iteration, status, started_at, completed_at, report_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.iteration,
        report.status,
        report.startedAt,
        report.completedAt,
        json(redactValue(report)),
      );
  }

  public async recordWorkspace(sessionId: string, rawWorkspace: ExecutionWorkspace): Promise<void> {
    const workspace = ExecutionWorkspaceSchema.parse(rawWorkspace);
    this.database
      .prepare(
        `INSERT INTO workspace_records(id, session_id, path, mode, status, created_at, workspace_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, workspace_json=excluded.workspace_json`,
      )
      .run(
        workspace.id,
        sessionId,
        workspace.path,
        workspace.mode,
        workspace.status,
        workspace.createdAt,
        json(workspace),
      );
  }

  public async recordUserDecision(record: UserDecisionRecord): Promise<void> {
    this.database
      .prepare(
        'INSERT INTO user_decisions(id, session_id, kind, created_at, decision_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.sessionId,
        record.kind,
        record.createdAt,
        json(redactValue(record.decision)),
      );
  }

  public async recordTokenUsage(record: TokenUsageRecord): Promise<void> {
    const usage = TokenUsageSchema.parse(record.usage);
    this.database
      .prepare(
        `INSERT INTO token_usage(id, session_id, provider_execution_id, role, created_at, usage_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.providerExecutionId ?? null,
        record.role,
        record.createdAt,
        json(usage),
      );
  }

  public async loadResumeSnapshot(sessionId: string): Promise<ResumeSnapshot | undefined> {
    const session = await this.getSession(sessionId);
    if (session === undefined) return undefined;
    const currentPlan =
      session.currentPlanVersion === undefined
        ? undefined
        : await this.getPlanRecord(sessionId, session.currentPlanVersion);
    const approvedPlan =
      session.approvedPlanVersion === undefined
        ? undefined
        : await this.getPlanRecord(sessionId, session.approvedPlanVersion);
    const findingRows = this.database
      .prepare(
        `SELECT finding_json AS value FROM review_findings
         WHERE session_id = ? AND status = 'OPEN' ORDER BY finding_id`,
      )
      .all(sessionId) as readonly JsonRow[];
    const providerRow = this.database
      .prepare(
        `SELECT * FROM provider_executions
         WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as ProviderExecutionRow | undefined;
    const workerRows = this.database
      .prepare(
        `SELECT * FROM worker_iterations
         WHERE session_id = ? ORDER BY started_at, rowid`,
      )
      .all(sessionId) as readonly WorkerIterationRow[];
    const qualityRows = this.database
      .prepare(
        `SELECT id, session_id, iteration, report_json FROM quality_gate_runs
         WHERE session_id = ? ORDER BY started_at, rowid`,
      )
      .all(sessionId) as readonly QualityGateRunRow[];
    const reviewRows = this.database
      .prepare(
        `SELECT * FROM review_decisions
         WHERE session_id = ? ORDER BY created_at, rowid`,
      )
      .all(sessionId) as readonly ReviewDecisionRow[];
    const workspaceRow = this.database
      .prepare(
        `SELECT workspace_json AS value FROM workspace_records
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as JsonRow | undefined;

    const workerIterations = workerRows.map((row) => this.workerIterationFromRow(row));
    const reviewDecisions = reviewRows.map((row) => this.reviewDecisionFromRow(row));
    const qualityGateRuns = qualityRows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      iteration: row.iteration,
      report: QualityGateReportSchema.parse(parseUnknown(row.report_json)),
    }));
    const lastWorkerIteration = workerIterations.at(-1);
    const lastReviewDecision = reviewDecisions.at(-1);
    const latestQualityGateReport = qualityGateRuns.at(-1)?.report;
    const workspace =
      workspaceRow === undefined
        ? session.workspace
        : ExecutionWorkspaceSchema.parse(parseUnknown(workspaceRow.value));
    const resumedSession =
      workspace === undefined ? session : TaskSessionSchema.parse({...session, workspace});

    return {
      session: resumedSession,
      ...optional('currentPlan', currentPlan),
      ...optional('approvedPlan', approvedPlan),
      events: await this.listEvents(sessionId),
      openFindings: findingRows.map((row) => ReviewFindingSchema.parse(parseUnknown(row.value))),
      ...optional(
        'lastProviderExecution',
        providerRow === undefined ? undefined : this.providerExecutionFromRow(providerRow),
      ),
      ...optional('lastWorkerIteration', lastWorkerIteration),
      ...optional('lastReviewDecision', lastReviewDecision),
      ...optional('latestQualityGateReport', latestQualityGateReport),
      workerIterations,
      reviewDecisions,
      qualityGateRuns,
      ...optional('workspace', workspace),
    };
  }

  public async reconcileAuditLog(): Promise<void> {
    if (this.auditLog === undefined) return;
    const exportedIds = await this.auditLog.eventIds();
    const pending = this.database
      .prepare(
        'SELECT event_json FROM workflow_events WHERE audit_exported = 0 ORDER BY timestamp, rowid',
      )
      .all() as readonly EventRow[];
    for (const row of pending) {
      const event = WorkflowEventRecordSchema.parse(parseUnknown(row.event_json));
      if (!exportedIds.has(event.id)) await this.auditLog.append(event);
      this.database
        .prepare('UPDATE workflow_events SET audit_exported = 1 WHERE id = ?')
        .run(event.id);
    }
  }

  private challengeFailureWithinTransaction(
    input: ConsumeApprovalChallengeInput,
    planVersion?: number,
    sourceBaseline?: string,
  ): ChallengeFailure | undefined {
    const row = this.database
      .prepare('SELECT * FROM approval_challenges WHERE id = ?')
      .get(input.challengeId) as ApprovalChallengeRow | undefined;
    if (
      row?.session_id !== input.sessionId ||
      row.purpose !== input.purpose ||
      row.subject_hash !== input.subjectHash ||
      (planVersion !== undefined && row.plan_version !== planVersion) ||
      (sourceBaseline !== undefined && row.source_baseline !== sourceBaseline)
    ) {
      return 'mismatch';
    }
    if (row.status !== 'PENDING') return 'not-pending';
    if (row.expires_at <= input.consumedAt) {
      this.database
        .prepare("UPDATE approval_challenges SET status = 'EXPIRED' WHERE id = ?")
        .run(input.challengeId);
      return 'expired';
    }
    const update = this.database
      .prepare(
        `UPDATE approval_challenges SET status = 'CONSUMED', consumed_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(input.consumedAt, input.challengeId);
    return update.changes === 1 ? undefined : 'not-pending';
  }

  private writeTransitionRows(
    previous: TaskSession,
    next: TaskSession,
    event: WorkflowEventRecord,
  ): void {
    const current = this.database
      .prepare('SELECT state, updated_at FROM sessions WHERE id = ?')
      .get(previous.id) as {state: string; updated_at: string} | undefined;
    if (current?.state !== previous.state || current.updated_at !== previous.updatedAt) {
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
    this.database
      .prepare('UPDATE sessions SET updated_at = ?, state = ?, session_json = ? WHERE id = ?')
      .run(next.updatedAt, next.state, json(next), next.id);
    this.database
      .prepare(
        `INSERT INTO workflow_events(
           id, session_id, timestamp, previous_state, next_state, event_type, event_json, audit_exported
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.timestamp,
        event.previousState,
        event.nextState,
        event.event.type,
        json(event),
        this.auditLog === undefined ? 1 : 0,
      );
  }

  private providerExecutionFromRow(row: ProviderExecutionRow): ProviderExecutionRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      providerId: row.provider_id,
      ...optional('model', row.model),
      status: row.status,
      startedAt: row.started_at,
      ...optional('completedAt', row.completed_at),
      ...optional('providerSessionId', row.provider_session_id),
      ...optional('requestHash', row.request_hash),
      ...optional('result', row.result_json === null ? undefined : parseUnknown(row.result_json)),
      ...optional('errorCode', row.error_code),
    };
  }

  private workerIterationFromRow(row: WorkerIterationRow): WorkerIterationRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      iteration: row.iteration,
      kind: row.kind,
      startedAt: row.started_at,
      ...optional('completedAt', row.completed_at),
      ...optional(
        'result',
        row.result_json === null
          ? undefined
          : WorkerExecutionResultSchema.parse(parseUnknown(row.result_json)),
      ),
      ...optional('diffHash', row.diff_hash),
      ...optional('providerResponseHash', row.provider_response_hash),
    };
  }

  private reviewDecisionFromRow(row: ReviewDecisionRow): ReviewDecisionRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      iteration: row.iteration,
      phase: row.phase,
      createdAt: row.created_at,
      decision: ReviewDecisionSchema.parse(parseUnknown(row.decision_json)),
    };
  }

  private approvalChallengeFromRow(row: ApprovalChallengeRow): ApprovalChallenge {
    return ApprovalChallengeSchema.parse({
      schemaVersion: 1,
      id: row.id,
      sessionId: row.session_id,
      purpose: row.purpose,
      subjectHash: row.subject_hash,
      ...optional('planVersion', row.plan_version),
      ...optional('sourceBaseline', row.source_baseline),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      ...optional('consumedAt', row.consumed_at),
    });
  }
}
