import {z} from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);
const TimestampSchema = z.iso.datetime({offset: true});

export const WorkflowStateSchema = z.enum([
  'CREATED',
  'DISCOVERING_REPOSITORY',
  'REQUIREMENT_DISCOVERY',
  'DRAFTING_PLAN',
  'AWAITING_PLAN_REVIEW',
  'REVISING_PLAN',
  'PLAN_APPROVED',
  'PREPARING_WORKSPACE',
  'EXECUTING_WORKER',
  'RUNNING_QUALITY_GATES',
  'REPAIRING_MECHANICAL_FAILURES',
  'SUPERVISOR_REVIEW',
  'AWAITING_USER_DECISION',
  'REVISING_IMPLEMENTATION',
  'FINAL_REVIEW',
  'TECHNICALLY_APPROVED',
  'AWAITING_APPLY_APPROVAL',
  'APPLYING_CHANGES',
  'COMPLETED',
  'PAUSED',
  'FAILED',
  'CANCELLED',
]);

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const ExecutionWorkspaceSchema = z.strictObject({
  id: NonEmptyTextSchema,
  path: NonEmptyTextSchema,
  mode: z.enum(['worktree', 'snapshot', 'current']),
  status: z.enum(['PREPARING', 'READY', 'PRESERVED', 'APPLIED', 'DISCARDED']),
  baseRevision: NonEmptyTextSchema.optional(),
  baseTree: NonEmptyTextSchema.optional(),
  sourceProjectRoot: NonEmptyTextSchema.optional(),
  sourceBranch: NonEmptyTextSchema.optional(),
  baselineFingerprint: NonEmptyTextSchema.optional(),
  baselineManifestPath: NonEmptyTextSchema.optional(),
  snapshotBaselinePath: NonEmptyTextSchema.optional(),
  includedTrackedChanges: z.boolean().optional(),
  excludedPaths: z.array(NonEmptyTextSchema).optional(),
  createdAt: TimestampSchema,
});

export type ExecutionWorkspace = z.infer<typeof ExecutionWorkspaceSchema>;

export const TaskSessionSchema = z.strictObject({
  id: NonEmptyTextSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  projectRoot: NonEmptyTextSchema,
  userRequest: NonEmptyTextSchema.optional(),
  frontendProvider: NonEmptyTextSchema,
  supervisorProvider: NonEmptyTextSchema,
  supervisorModel: NonEmptyTextSchema.optional(),
  workerProvider: NonEmptyTextSchema,
  workerModel: NonEmptyTextSchema.optional(),
  profileName: NonEmptyTextSchema,
  state: WorkflowStateSchema,
  currentPlanVersion: z.number().int().positive().optional(),
  approvedPlanVersion: z.number().int().positive().optional(),
  workspace: ExecutionWorkspaceSchema.optional(),
  iteration: z.number().int().nonnegative(),
  statusMessage: NonEmptyTextSchema.optional(),
});

export type TaskSession = z.infer<typeof TaskSessionSchema>;
