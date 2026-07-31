import {z} from 'zod';

const IdentifierSchema = z.string().trim().min(1).max(128);
const NonEmptyTextSchema = z.string().trim().min(1);
const TimestampSchema = z.iso.datetime({offset: true});

export const RequirementDiscoveryResultSchema = z.strictObject({
  summary: NonEmptyTextSchema,
  repositoryObservations: z.array(NonEmptyTextSchema),
  questions: z.array(NonEmptyTextSchema),
  proposedAssumptions: z.array(NonEmptyTextSchema),
  sufficient: z.boolean(),
});

export type RequirementDiscoveryResult = z.infer<typeof RequirementDiscoveryResultSchema>;

export const AssumptionSchema = z.strictObject({
  id: IdentifierSchema,
  description: NonEmptyTextSchema,
  status: z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED']),
});

export type Assumption = z.infer<typeof AssumptionSchema>;

export const RequirementSchema = z.strictObject({
  id: IdentifierSchema,
  description: NonEmptyTextSchema,
  priority: z.enum(['must', 'should', 'could']),
  source: z.enum(['user', 'repository', 'supervisor']),
});

export type Requirement = z.infer<typeof RequirementSchema>;

export const AcceptanceCriterionSchema = z.strictObject({
  id: IdentifierSchema,
  description: NonEmptyTextSchema,
  verificationMethod: z.enum([
    'test',
    'command',
    'static-analysis',
    'manual-review',
    'supervisor-review',
  ]),
  evidenceExpectation: NonEmptyTextSchema,
  priority: z.enum(['must', 'should', 'could']),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const ImplementationStepSchema = z.strictObject({
  id: IdentifierSchema,
  title: NonEmptyTextSchema,
  description: NonEmptyTextSchema,
  dependencies: z.array(IdentifierSchema),
  expectedOutputs: z.array(NonEmptyTextSchema),
  allowedAreas: z.array(NonEmptyTextSchema).optional(),
  requiresUserDecision: z.boolean(),
});

export type ImplementationStep = z.infer<typeof ImplementationStepSchema>;

export const VerificationCommandSchema = z.strictObject({
  id: IdentifierSchema,
  command: z.array(NonEmptyTextSchema).min(1),
  cwd: NonEmptyTextSchema.optional(),
  required: z.boolean(),
  timeoutSeconds: z.number().int().positive(),
});

export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

export const RiskSchema = z.strictObject({
  id: IdentifierSchema,
  description: NonEmptyTextSchema,
  likelihood: z.enum(['low', 'medium', 'high']),
  impact: z.enum(['low', 'medium', 'high', 'critical']),
  mitigation: NonEmptyTextSchema,
});

export type Risk = z.infer<typeof RiskSchema>;

export const UserDecisionRecordSchema = z.strictObject({
  id: IdentifierSchema,
  question: NonEmptyTextSchema,
  decision: NonEmptyTextSchema,
  impact: NonEmptyTextSchema.optional(),
  decidedAt: TimestampSchema,
});

export type UserDecisionRecord = z.infer<typeof UserDecisionRecordSchema>;

const duplicateIdentifiers = (values: readonly {id: string}[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return [...duplicates];
};

export const TaskPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    taskId: IdentifierSchema,
    version: z.number().int().positive(),
    status: z.enum(['DRAFT', 'APPROVED', 'SUPERSEDED']),
    title: NonEmptyTextSchema,
    objective: NonEmptyTextSchema,
    userIntentSummary: NonEmptyTextSchema,
    assumptions: z.array(AssumptionSchema),
    requirements: z.array(RequirementSchema),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema),
    implementationSteps: z.array(ImplementationStepSchema),
    expectedFileAreas: z.array(NonEmptyTextSchema),
    verificationCommands: z.array(VerificationCommandSchema),
    risks: z.array(RiskSchema),
    outOfScope: z.array(NonEmptyTextSchema),
    userDecisions: z.array(UserDecisionRecordSchema),
    createdAt: TimestampSchema,
    approvedAt: TimestampSchema.optional(),
  })
  .superRefine((plan, context) => {
    const identifiedCollections = [
      plan.assumptions,
      plan.requirements,
      plan.acceptanceCriteria,
      plan.implementationSteps,
      plan.verificationCommands,
      plan.risks,
      plan.userDecisions,
    ];
    for (const collection of identifiedCollections) {
      for (const duplicate of duplicateIdentifiers(collection)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate identifier ${duplicate}`,
        });
      }
    }

    const stepIds = new Set(plan.implementationSteps.map(({id}) => id));
    for (const step of plan.implementationSteps) {
      for (const dependency of step.dependencies) {
        if (!stepIds.has(dependency)) {
          context.addIssue({
            code: 'custom',
            message: `step ${step.id} depends on unknown step ${dependency}`,
          });
        }
        if (dependency === step.id) {
          context.addIssue({
            code: 'custom',
            message: `step ${step.id} cannot depend on itself`,
          });
        }
      }
    }

    if (plan.status === 'APPROVED' && plan.approvedAt === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'an approved plan requires approvedAt',
        path: ['approvedAt'],
      });
    }
    if (plan.status === 'DRAFT' && plan.approvedAt !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a draft plan cannot have approvedAt',
        path: ['approvedAt'],
      });
    }
  });

export type TaskPlan = z.infer<typeof TaskPlanSchema>;
