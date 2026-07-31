import {z} from 'zod';

const NonEmptyTextSchema = z.string().trim().min(1);

export const ProviderCapabilitiesSchema = z.strictObject({
  supervisorPlanning: z.boolean(),
  supervisorReview: z.boolean(),
  workerExecution: z.boolean(),
  structuredOutput: z.boolean(),
  sessionResume: z.boolean(),
  filesystemTools: z.boolean(),
  shellTools: z.boolean(),
  streaming: z.boolean(),
  tokenUsageReporting: z.boolean(),
  modelDiscovery: z.boolean(),
});

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderDescriptorSchema = z.strictObject({
  id: NonEmptyTextSchema,
  displayName: NonEmptyTextSchema,
  version: NonEmptyTextSchema.optional(),
  transport: z.enum(['cli', 'http', 'sdk']),
  capabilities: ProviderCapabilitiesSchema,
  experimental: z.boolean().optional(),
});

export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

export const ProviderHealthSchema = z.strictObject({
  status: z.enum(['PASS', 'WARN', 'FAIL', 'SKIP']),
  message: NonEmptyTextSchema,
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const ModelDescriptorSchema = z.strictObject({
  id: NonEmptyTextSchema,
  displayName: NonEmptyTextSchema.optional(),
  available: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const TokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  estimatedCost: z.number().nonnegative().optional(),
  currency: NonEmptyTextSchema.optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
