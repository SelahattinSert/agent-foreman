import {z} from 'zod';

import {WorkflowStateSchema} from './task.js';
import {ExecutionWorkspaceSchema} from './task.js';

const NonEmptyTextSchema = z.string().trim().min(1);

export const WorkflowEventSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('SESSION_STARTED')}),
  z.strictObject({type: z.literal('REPOSITORY_DISCOVERED')}),
  z.strictObject({type: z.literal('REQUIREMENTS_SUFFICIENT')}),
  z.strictObject({type: z.literal('PLAN_DRAFTED'), planVersion: z.number().int().positive()}),
  z.strictObject({type: z.literal('PLAN_CHANGE_REQUESTED')}),
  z.strictObject({type: z.literal('PLAN_APPROVED'), planVersion: z.number().int().positive()}),
  z.strictObject({type: z.literal('WORKSPACE_PREPARATION_STARTED')}),
  z.strictObject({
    type: z.literal('WORKSPACE_READY'),
    workspace: ExecutionWorkspaceSchema.optional(),
  }),
  z.strictObject({type: z.literal('WORKER_FINISHED')}),
  z.strictObject({type: z.literal('QUALITY_GATES_PASSED')}),
  z.strictObject({type: z.literal('QUALITY_GATES_FAILED')}),
  z.strictObject({type: z.literal('MECHANICAL_REPAIR_FINISHED')}),
  z.strictObject({type: z.literal('SUPERVISOR_APPROVED')}),
  z.strictObject({type: z.literal('SUPERVISOR_REQUESTED_REVISION')}),
  z.strictObject({type: z.literal('WORKER_RETRY_STARTED')}),
  z.strictObject({type: z.literal('WORKER_REVISION_STARTED')}),
  z.strictObject({type: z.literal('USER_DECISION_REQUIRED')}),
  z.strictObject({type: z.literal('USER_DECISION_RECEIVED')}),
  z.strictObject({type: z.literal('APPLY_REVIEW_READY')}),
  z.strictObject({type: z.literal('APPLY_APPROVED')}),
  z.strictObject({type: z.literal('APPLY_RETRY_READY')}),
  z.strictObject({
    type: z.literal('CHANGES_APPLIED'),
    workspace: ExecutionWorkspaceSchema.optional(),
  }),
  z.strictObject({type: z.literal('TASK_CANCELLED')}),
  z.strictObject({type: z.literal('TASK_PAUSED'), reason: NonEmptyTextSchema}),
  z.strictObject({type: z.literal('TASK_RESUMED'), resumeState: WorkflowStateSchema}),
  z.strictObject({type: z.literal('FATAL_ERROR'), reason: NonEmptyTextSchema}),
]);

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

export const WorkflowEventRecordSchema = z.strictObject({
  id: NonEmptyTextSchema,
  sessionId: NonEmptyTextSchema,
  timestamp: z.iso.datetime({offset: true}),
  previousState: WorkflowStateSchema,
  nextState: WorkflowStateSchema,
  event: WorkflowEventSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type WorkflowEventRecord = z.infer<typeof WorkflowEventRecordSchema>;
