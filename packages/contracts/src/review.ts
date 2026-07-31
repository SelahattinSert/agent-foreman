import {z} from 'zod';

const IdentifierSchema = z.string().trim().min(1).max(128);
const NonEmptyTextSchema = z.string().trim().min(1);

export const EvidenceReferenceSchema = z.strictObject({
  kind: z.enum(['file', 'diff', 'command', 'test', 'quality-gate']),
  reference: NonEmptyTextSchema,
  detail: NonEmptyTextSchema.optional(),
  line: z.number().int().positive().optional(),
});

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const AcceptanceCriterionReviewSchema = z.strictObject({
  acceptanceCriterionId: IdentifierSchema,
  status: z.enum(['PASSED', 'FAILED', 'NOT_VERIFIED']),
  summary: NonEmptyTextSchema,
  evidence: z.array(EvidenceReferenceSchema),
});

export type AcceptanceCriterionReview = z.infer<typeof AcceptanceCriterionReviewSchema>;

export const ReviewFindingSchema = z.strictObject({
  id: IdentifierSchema,
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.enum([
    'correctness',
    'security',
    'testing',
    'architecture',
    'performance',
    'maintainability',
    'scope',
    'documentation',
  ]),
  title: NonEmptyTextSchema,
  problem: NonEmptyTextSchema,
  evidence: z.array(EvidenceReferenceSchema),
  requiredChange: NonEmptyTextSchema,
  verification: NonEmptyTextSchema,
  relatedAcceptanceCriteria: z.array(IdentifierSchema),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    verdict: z.enum(['APPROVED', 'REVISE', 'BLOCKED']),
    score: z.number().min(0).max(100).optional(),
    summary: NonEmptyTextSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionReviewSchema),
    findings: z.array(ReviewFindingSchema),
    resolvedFindingIds: z.array(IdentifierSchema),
    openFindingIds: z.array(IdentifierSchema),
    newFindingIds: z.array(IdentifierSchema),
    scopeAssessment: z.strictObject({
      withinApprovedPlan: z.boolean(),
      unexpectedChanges: z.array(NonEmptyTextSchema),
    }),
    recommendedNextAction: z.enum(['finish', 'return_to_worker', 'ask_user', 'pause']),
  })
  .superRefine((decision, context) => {
    const findingIds = new Set(decision.findings.map(({id}) => id));
    const lifecycleIds = [
      ...decision.resolvedFindingIds,
      ...decision.openFindingIds,
      ...decision.newFindingIds,
    ];
    for (const id of lifecycleIds) {
      if (!findingIds.has(id)) {
        context.addIssue({
          code: 'custom',
          message: `finding lifecycle references unknown finding ${id}`,
        });
      }
    }
  });

export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const FinalReviewDecisionSchema = ReviewDecisionSchema;
export type FinalReviewDecision = z.infer<typeof FinalReviewDecisionSchema>;
