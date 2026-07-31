import {mkdir} from 'node:fs/promises';
import path from 'node:path';

/* eslint-disable @typescript-eslint/require-await -- The async repository port is backed by a synchronous transactional SQLite driver. */

import Database from 'better-sqlite3';

import {
  ExecutionWorkspaceSchema,
  QualityGateReportSchema,
  ReviewDecisionSchema,
  ReviewFindingSchema,
  TaskPlanSchema,
  TaskSessionSchema,
  TokenUsageSchema,
  WorkflowEventRecordSchema,
  WorkerExecutionResultSchema,
  type ExecutionWorkspace,
  type TaskPlan,
  type TaskSession,
  type WorkflowEventRecord,
} from '@agent-foreman/contracts';
import {PersistenceError} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';

import {JsonlAuditLog} from '../jsonl/audit-log.js';
import type {
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

export class SqliteWorkflowStore implements WorkflowStore, RuntimeRecordRepository {
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
    const workerRow = this.database
      .prepare(
        `SELECT * FROM worker_iterations
         WHERE session_id = ? ORDER BY iteration DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as WorkerIterationRow | undefined;
    const qualityRow = this.database
      .prepare(
        `SELECT report_json AS value FROM quality_gate_runs
         WHERE session_id = ? ORDER BY iteration DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as JsonRow | undefined;
    const reviewRow = this.database
      .prepare(
        `SELECT * FROM review_decisions
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as ReviewDecisionRow | undefined;
    const workspaceRow = this.database
      .prepare(
        `SELECT workspace_json AS value FROM workspace_records
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as JsonRow | undefined;

    return {
      session,
      ...optional('currentPlan', currentPlan),
      ...optional('approvedPlan', approvedPlan),
      events: await this.listEvents(sessionId),
      openFindings: findingRows.map((row) => ReviewFindingSchema.parse(parseUnknown(row.value))),
      ...optional(
        'lastProviderExecution',
        providerRow === undefined ? undefined : this.providerExecutionFromRow(providerRow),
      ),
      ...optional(
        'lastWorkerIteration',
        workerRow === undefined ? undefined : this.workerIterationFromRow(workerRow),
      ),
      ...optional(
        'lastReviewDecision',
        reviewRow === undefined
          ? undefined
          : {
              id: reviewRow.id,
              sessionId: reviewRow.session_id,
              iteration: reviewRow.iteration,
              phase: reviewRow.phase,
              createdAt: reviewRow.created_at,
              decision: ReviewDecisionSchema.parse(parseUnknown(reviewRow.decision_json)),
            },
      ),
      ...optional(
        'latestQualityGateReport',
        qualityRow === undefined
          ? undefined
          : QualityGateReportSchema.parse(parseUnknown(qualityRow.value)),
      ),
      ...optional(
        'workspace',
        workspaceRow === undefined
          ? session.workspace
          : ExecutionWorkspaceSchema.parse(parseUnknown(workspaceRow.value)),
      ),
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
}
