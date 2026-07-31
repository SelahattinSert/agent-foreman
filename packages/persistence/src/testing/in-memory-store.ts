import {
  TaskPlanSchema,
  TaskSessionSchema,
  WorkflowEventRecordSchema,
  type TaskPlan,
  type TaskSession,
  type WorkflowEventRecord,
} from '@agent-foreman/contracts';

import type {PlanApprovalRecord, PlanRecord, WorkflowStore} from '../ports.js';

const planKey = (taskId: string, version: number): string => `${taskId}:${String(version)}`;

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly sessions = new Map<string, TaskSession>();
  private readonly plans = new Map<string, TaskPlan>();
  private readonly events = new Map<string, WorkflowEventRecord[]>();
  private readonly planRecords = new Map<string, PlanRecord>();
  private readonly approvals = new Map<string, PlanApprovalRecord>();

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
}
