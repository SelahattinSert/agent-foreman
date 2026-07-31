import {z} from 'zod';

import {TaskPlanSchema} from './planning.js';
import {TokenUsageSchema} from './provider.js';
import {ReviewFindingSchema} from './review.js';

const NonEmptyTextSchema = z.string().trim().min(1);

export const WorkspaceRelativePathSchema = NonEmptyTextSchema.superRefine((value, context) => {
  const hasParentSegment = value.split(/[\\/]/u).includes('..');
  const isAbsolute =
    value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(value);
  if (hasParentSegment || isAbsolute) {
    context.addIssue({code: 'custom', message: 'path must be a relative workspace path'});
  }
});

export const ChangedFileSchema = z.strictObject({
  path: WorkspaceRelativePathSchema,
  changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
  previousPath: WorkspaceRelativePathSchema.optional(),
});

export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const CommandExecutionSummarySchema = z.strictObject({
  executable: NonEmptyTextSchema,
  args: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
});

export type CommandExecutionSummary = z.infer<typeof CommandExecutionSummarySchema>;

export const WorkerBlockerTypeSchema = z.enum([
  'IMPLEMENTATION_DETAIL',
  'PLAN_CONFLICT',
  'USER_DECISION_REQUIRED',
  'ENVIRONMENT_FAILURE',
  'MISSING_DEPENDENCY',
  'PERMISSION_REQUIRED',
]);

export type WorkerBlockerType = z.infer<typeof WorkerBlockerTypeSchema>;

export const WorkerBlockerSchema = z.strictObject({
  type: WorkerBlockerTypeSchema,
  summary: NonEmptyTextSchema,
  details: NonEmptyTextSchema,
  retryable: z.boolean(),
  suggestedOptions: z.array(NonEmptyTextSchema),
});

export type WorkerBlocker = z.infer<typeof WorkerBlockerSchema>;

export const WorkerExecutionResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionId: NonEmptyTextSchema,
  providerSessionId: NonEmptyTextSchema.optional(),
  status: z.enum(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED']),
  summary: NonEmptyTextSchema,
  changedFiles: z.array(ChangedFileSchema),
  commandsRun: z.array(CommandExecutionSummarySchema),
  testsAdded: z.array(WorkspaceRelativePathSchema),
  acceptanceCriteriaWorkedOn: z.array(NonEmptyTextSchema),
  assumptionsMade: z.array(NonEmptyTextSchema),
  blockers: z.array(WorkerBlockerSchema),
  knownIssues: z.array(NonEmptyTextSchema),
  tokenUsage: TokenUsageSchema.optional(),
});

export type WorkerExecutionResult = z.infer<typeof WorkerExecutionResultSchema>;

export const WorkerConstraintsSchema = z.strictObject({
  allowedAreas: z.array(WorkspaceRelativePathSchema),
  deniedAreas: z.array(WorkspaceRelativePathSchema),
  networkAccess: z.enum(['denied', 'ask', 'allowed']),
  destructiveCommands: z.enum(['denied', 'ask']),
  maximumChangedFiles: z.number().int().positive().optional(),
});

export type WorkerConstraints = z.infer<typeof WorkerConstraintsSchema>;

export const QualityGateFailureSchema = z.strictObject({
  gateId: NonEmptyTextSchema,
  type: NonEmptyTextSchema,
  summary: NonEmptyTextSchema,
  fingerprint: NonEmptyTextSchema,
  required: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

export type QualityGateFailure = z.infer<typeof QualityGateFailureSchema>;

export const QualityGateRunResultSchema = z.strictObject({
  gateId: NonEmptyTextSchema,
  type: NonEmptyTextSchema,
  status: z.enum(['PASSED', 'FAILED', 'CANCELLED']),
  required: z.boolean(),
  executable: NonEmptyTextSchema,
  args: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  fingerprint: NonEmptyTextSchema,
});

export type QualityGateRunResult = z.infer<typeof QualityGateRunResultSchema>;

export const QualityGateReportSchema = z.strictObject({
  status: z.enum(['PASSED', 'FAILED', 'CANCELLED']),
  failures: z.array(QualityGateFailureSchema),
  startedAt: z.iso.datetime({offset: true}),
  completedAt: z.iso.datetime({offset: true}),
  runs: z.array(QualityGateRunResultSchema).optional(),
});

export type QualityGateReport = z.infer<typeof QualityGateReportSchema>;

export const ProjectSummarySchema = z.strictObject({
  root: NonEmptyTextSchema,
  vcs: z.enum(['git', 'none']),
  languages: z.array(NonEmptyTextSchema),
  packageManagers: z.array(NonEmptyTextSchema),
  relevantFiles: z.array(WorkspaceRelativePathSchema),
  summary: NonEmptyTextSchema,
});

export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const FileContextSchema = z.strictObject({
  path: WorkspaceRelativePathSchema,
  content: z.string(),
  reason: NonEmptyTextSchema,
  truncated: z.boolean(),
});

export type FileContext = z.infer<typeof FileContextSchema>;

export const WorkerExecutionInputSchema = z.strictObject({
  approvedPlan: TaskPlanSchema,
  approvedPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
  projectSummary: ProjectSummarySchema,
  workspacePath: NonEmptyTextSchema,
  constraints: WorkerConstraintsSchema,
  baselineResults: QualityGateReportSchema,
  outputSchema: z.unknown(),
});

export type WorkerExecutionInput = z.infer<typeof WorkerExecutionInputSchema>;

export const WorkerRevisionInputSchema = z.strictObject({
  approvedPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
  iteration: z.number().int().positive(),
  openFindings: z.array(ReviewFindingSchema),
  qualityGateFailures: z.array(QualityGateFailureSchema),
  relevantDiff: z.string(),
  relevantFiles: z.array(FileContextSchema),
  userDecisionContext: z.array(NonEmptyTextSchema).optional(),
  constraints: WorkerConstraintsSchema,
});

export type WorkerRevisionInput = z.infer<typeof WorkerRevisionInputSchema>;
