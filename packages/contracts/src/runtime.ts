import {z} from 'zod';

import {TaskPlanSchema} from './planning.js';
import {ReviewDecisionSchema, ReviewFindingSchema} from './review.js';
import {ExecutionWorkspaceSchema, TaskSessionSchema, WorkflowStateSchema} from './task.js';
import {ChangedFileSchema, QualityGateReportSchema, WorkerExecutionResultSchema} from './worker.js';

const NonEmptyTextSchema = z.string().trim().min(1);
const TimestampSchema = z.iso.datetime({offset: true});
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 hash.');

export const ApprovalPurposeSchema = z.enum(['PLAN', 'APPLY']);
export type ApprovalPurpose = z.infer<typeof ApprovalPurposeSchema>;

export const ApprovalChallengeStatusSchema = z.enum([
  'PENDING',
  'CONSUMED',
  'EXPIRED',
  'CANCELLED',
]);
export type ApprovalChallengeStatus = z.infer<typeof ApprovalChallengeStatusSchema>;

export const ApprovalChallengeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: NonEmptyTextSchema,
    sessionId: NonEmptyTextSchema,
    purpose: ApprovalPurposeSchema,
    subjectHash: Sha256Schema,
    planVersion: z.number().int().positive().optional(),
    sourceBaseline: NonEmptyTextSchema.optional(),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: ApprovalChallengeStatusSchema,
    consumedAt: TimestampSchema.optional(),
  })
  .superRefine((challenge, context) => {
    if (challenge.expiresAt <= challenge.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Approval challenge expiry must be later than creation.',
      });
    }
    if (challenge.purpose === 'PLAN' && challenge.planVersion === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['planVersion'],
        message: 'Plan approval challenges require a plan version.',
      });
    }
    if (challenge.purpose === 'APPLY' && challenge.sourceBaseline === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['sourceBaseline'],
        message: 'Apply approval challenges require a source baseline.',
      });
    }
    if (challenge.status === 'CONSUMED' && challenge.consumedAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['consumedAt'],
        message: 'Consumed approval challenges require a consumption timestamp.',
      });
    }
  });
export type ApprovalChallenge = z.infer<typeof ApprovalChallengeSchema>;

export const SessionCreateInputSchema = z.strictObject({
  projectRoot: NonEmptyTextSchema,
  frontendProvider: NonEmptyTextSchema,
  profileName: NonEmptyTextSchema,
  task: NonEmptyTextSchema.optional(),
});
export type SessionCreateInput = z.infer<typeof SessionCreateInputSchema>;

export const PlanSubmitInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  plan: TaskPlanSchema,
  markdown: NonEmptyTextSchema,
});
export type PlanSubmitInput = z.infer<typeof PlanSubmitInputSchema>;

export const PlanApprovalRequestInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  planVersion: z.number().int().positive(),
  planHash: Sha256Schema,
});
export type PlanApprovalRequestInput = z.infer<typeof PlanApprovalRequestInputSchema>;

export const PlanApproveInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  challengeId: NonEmptyTextSchema,
  planHash: Sha256Schema,
});
export type PlanApproveInput = z.infer<typeof PlanApproveInputSchema>;

export const WorkerStartInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  approvedPlanHash: Sha256Schema,
  workspaceStrategy: z.enum(['cancel', 'head-worktree', 'include-tracked']).optional(),
});
export type WorkerStartInput = z.infer<typeof WorkerStartInputSchema>;

export const ReviewPacketInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  approvedPlanHash: Sha256Schema,
  maxDiffBytes: z.number().int().positive().max(1_000_000).optional(),
});
export type ReviewPacketInput = z.infer<typeof ReviewPacketInputSchema>;

export const RevisionSubmitInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  approvedPlanHash: Sha256Schema,
  iteration: z.number().int().positive(),
  review: ReviewDecisionSchema,
});
export type RevisionSubmitInput = z.infer<typeof RevisionSubmitInputSchema>;

export const ApplyRequestInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  reviewedDiffHash: Sha256Schema,
  sourceBaseline: NonEmptyTextSchema,
});
export type ApplyRequestInput = z.infer<typeof ApplyRequestInputSchema>;

export const ApplyApproveInputSchema = z.strictObject({
  sessionId: NonEmptyTextSchema,
  challengeId: NonEmptyTextSchema,
  reviewedDiffHash: Sha256Schema,
  sourceBaseline: NonEmptyTextSchema,
});
export type ApplyApproveInput = z.infer<typeof ApplyApproveInputSchema>;

export const RuntimeStatusInputSchema = z.strictObject({sessionId: NonEmptyTextSchema});
export type RuntimeStatusInput = z.infer<typeof RuntimeStatusInputSchema>;

export const RuntimeResumeInputSchema = z.strictObject({sessionId: NonEmptyTextSchema});
export type RuntimeResumeInput = z.infer<typeof RuntimeResumeInputSchema>;

export const RuntimeWorkspaceDiffSchema = z.strictObject({
  patch: z.string(),
  hash: Sha256Schema,
  changedFiles: z.array(ChangedFileSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type RuntimeWorkspaceDiff = z.infer<typeof RuntimeWorkspaceDiffSchema>;

export const NativeReviewPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: TaskSessionSchema,
  approvedPlanHash: Sha256Schema,
  phase: z.enum(['SEMANTIC', 'FINAL', 'APPLY', 'PAUSED']),
  workerResult: WorkerExecutionResultSchema,
  qualityGateReport: QualityGateReportSchema,
  diff: RuntimeWorkspaceDiffSchema,
  openFindings: z.array(ReviewFindingSchema),
});
export type NativeReviewPacket = z.infer<typeof NativeReviewPacketSchema>;

export const RuntimeResumePacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  session: TaskSessionSchema,
  nextAction: z.enum([
    'CONTINUE_PLANNING',
    'REVIEW_PLAN',
    'START_WORKER',
    'SUBMIT_REVIEW',
    'REQUEST_APPLY_APPROVAL',
    'INSPECT_PAUSED',
    'MANUAL_RECOVERY',
    'COMPLETED',
    'TERMINAL',
  ]),
  message: NonEmptyTextSchema,
  plan: TaskPlanSchema.optional(),
  planHash: Sha256Schema.optional(),
  approvedPlanHash: Sha256Schema.optional(),
  reviewPacket: NativeReviewPacketSchema.optional(),
});
export type RuntimeResumePacket = z.infer<typeof RuntimeResumePacketSchema>;

export const ApplyApprovalRequestSchema = z.strictObject({
  challenge: ApprovalChallengeSchema,
  session: TaskSessionSchema,
  diff: RuntimeWorkspaceDiffSchema,
});
export type ApplyApprovalRequest = z.infer<typeof ApplyApprovalRequestSchema>;

export const AppliedChangesResultSchema = z.strictObject({
  session: TaskSessionSchema,
  workspace: ExecutionWorkspaceSchema,
  diff: RuntimeWorkspaceDiffSchema,
});
export type AppliedChangesResult = z.infer<typeof AppliedChangesResultSchema>;

const commandEnvelope = <Command extends string, Input extends z.ZodType>(
  command: Command,
  input: Input,
): z.ZodObject<{
  schemaVersion: z.ZodLiteral<1>;
  requestId: typeof NonEmptyTextSchema;
  command: z.ZodLiteral<Command>;
  input: Input;
}> =>
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: NonEmptyTextSchema,
    command: z.literal(command),
    input,
  });

export const RuntimeCommandEnvelopeSchema = z.discriminatedUnion('command', [
  commandEnvelope('session.create', SessionCreateInputSchema),
  commandEnvelope('plan.submit', PlanSubmitInputSchema),
  commandEnvelope('plan.approval-request', PlanApprovalRequestInputSchema),
  commandEnvelope('plan.approve', PlanApproveInputSchema),
  commandEnvelope('worker.start', WorkerStartInputSchema),
  commandEnvelope('review.packet', ReviewPacketInputSchema),
  commandEnvelope('revision.submit', RevisionSubmitInputSchema),
  commandEnvelope('apply.request', ApplyRequestInputSchema),
  commandEnvelope('apply.approve', ApplyApproveInputSchema),
  commandEnvelope('resume', RuntimeResumeInputSchema),
  commandEnvelope('status', RuntimeStatusInputSchema),
]);
export type RuntimeCommandEnvelope = z.infer<typeof RuntimeCommandEnvelopeSchema>;

export const RuntimeSuccessEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: NonEmptyTextSchema,
  ok: z.literal(true),
  state: WorkflowStateSchema.optional(),
  data: z.unknown(),
});
export type RuntimeSuccessEnvelope = z.infer<typeof RuntimeSuccessEnvelopeSchema>;

export const RuntimeErrorEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: NonEmptyTextSchema,
  ok: z.literal(false),
  error: z.strictObject({
    code: NonEmptyTextSchema,
    message: NonEmptyTextSchema,
    retryable: z.boolean(),
    state: WorkflowStateSchema.optional(),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type RuntimeErrorEnvelope = z.infer<typeof RuntimeErrorEnvelopeSchema>;

export const RuntimeResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  RuntimeSuccessEnvelopeSchema,
  RuntimeErrorEnvelopeSchema,
]);
export type RuntimeResponseEnvelope = z.infer<typeof RuntimeResponseEnvelopeSchema>;
