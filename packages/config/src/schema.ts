import {z} from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);

export const LogLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);

export const ProfileRoleSchema = z.strictObject({
  provider: NonEmptyTextSchema,
  model: NonEmptyTextSchema.optional(),
  reasoningEffort: NonEmptyTextSchema.optional(),
  sessionMode: NonEmptyTextSchema.optional(),
});

export const ProfileSchema = z.strictObject({
  supervisor: ProfileRoleSchema,
  worker: ProfileRoleSchema,
});

export const QualityGateTypeSchema = z.enum([
  'command',
  'test',
  'lint',
  'typecheck',
  'build',
  'format-check',
  'secret-scan',
  'scope-check',
  'changed-files-check',
  'diff-size-check',
  'custom',
]);

export const QualityGateConfigSchema = z.strictObject({
  id: NonEmptyTextSchema,
  type: QualityGateTypeSchema,
  command: z.array(z.string()).min(1).optional(),
  required: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

export const ConfigDocumentSchema = z.strictObject({
  version: z.literal(1),
  activeProfile: NonEmptyTextSchema.optional(),
  general: z
    .strictObject({
      uiLanguage: NonEmptyTextSchema.optional(),
      telemetry: z.boolean().optional(),
      logLevel: LogLevelSchema.optional(),
    })
    .optional(),
  workspace: z
    .strictObject({
      mode: z.enum(['smart', 'worktree', 'snapshot', 'current']).optional(),
      preserveOnFailure: z.boolean().optional(),
      preserveOnPause: z.boolean().optional(),
    })
    .optional(),
  planning: z
    .strictObject({
      requireExplicitApproval: z.boolean().optional(),
      allowRepositoryRead: z.boolean().optional(),
      allowBaselineChecks: z.boolean().optional(),
      networkAccess: z.boolean().optional(),
    })
    .optional(),
  workflow: z
    .strictObject({
      maxWorkerIterations: z.number().int().positive().optional(),
      maxMechanicalRepairs: z.number().int().nonnegative().optional(),
      maxSupervisorReviews: z.number().int().positive().optional(),
      maxSameFindingOccurrences: z.number().int().positive().optional(),
      pauseOnNoProgressIterations: z.number().int().positive().optional(),
      detectDiffOscillation: z.boolean().optional(),
    })
    .optional(),
  profiles: z.record(NonEmptyTextSchema, ProfileSchema).optional(),
  providers: z.record(NonEmptyTextSchema, z.record(z.string(), z.unknown())).optional(),
  quality: z
    .strictObject({
      requireSupervisorApproval: z.boolean().optional(),
      maximumOpenCritical: z.number().int().nonnegative().optional(),
      maximumOpenHigh: z.number().int().nonnegative().optional(),
      allowOpenMedium: z.boolean().optional(),
      allowOpenLow: z.boolean().optional(),
      gates: z.array(QualityGateConfigSchema).optional(),
    })
    .optional(),
});

export type ConfigDocument = z.infer<typeof ConfigDocumentSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileRole = z.infer<typeof ProfileRoleSchema>;
export type QualityGateConfig = z.infer<typeof QualityGateConfigSchema>;

export interface CliConfigOverrides {
  readonly profileName?: string;
  readonly supervisorProvider?: string;
  readonly supervisorModel?: string;
  readonly workerProvider?: string;
  readonly workerModel?: string;
}

export interface ConfigSources {
  readonly cli?: CliConfigOverrides;
  readonly global?: ConfigDocument;
  readonly project?: ConfigDocument;
}

export interface ResolvedConfig {
  readonly version: 1;
  readonly activeProfile: string;
  readonly general: {
    readonly uiLanguage: string;
    readonly telemetry: boolean;
    readonly logLevel: z.infer<typeof LogLevelSchema>;
  };
  readonly workspace: {
    readonly mode: 'smart' | 'worktree' | 'snapshot' | 'current';
    readonly preserveOnFailure: boolean;
    readonly preserveOnPause: boolean;
  };
  readonly planning: {
    readonly requireExplicitApproval: boolean;
    readonly allowRepositoryRead: boolean;
    readonly allowBaselineChecks: boolean;
    readonly networkAccess: boolean;
  };
  readonly workflow: {
    readonly maxWorkerIterations: number;
    readonly maxMechanicalRepairs: number;
    readonly maxSupervisorReviews: number;
    readonly maxSameFindingOccurrences: number;
    readonly pauseOnNoProgressIterations: number;
    readonly detectDiffOscillation: boolean;
  };
  readonly quality: {
    readonly requireSupervisorApproval: boolean;
    readonly maximumOpenCritical: number;
    readonly maximumOpenHigh: number;
    readonly allowOpenMedium: boolean;
    readonly allowOpenLow: boolean;
    readonly gates: readonly QualityGateConfig[];
  };
  readonly supervisor: ProfileRole;
  readonly worker: ProfileRole;
  readonly providers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
