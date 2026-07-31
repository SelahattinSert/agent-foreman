import type {
  FinalReviewDecision,
  ModelDescriptor,
  ProjectSummary,
  ProviderDescriptor,
  ProviderHealth,
  QualityGateReport,
  RequirementDiscoveryResult,
  ReviewDecision,
  TaskPlan,
  WorkerExecutionInput,
  WorkerExecutionResult,
  WorkerRevisionInput,
} from '@agent-foreman/contracts';

import type {ProviderExecutionContext} from './context.js';

export interface RequirementDiscoveryInput {
  readonly userRequest: string;
  readonly conversation: readonly {
    readonly role: 'user' | 'supervisor';
    readonly content: string;
  }[];
  readonly projectSummary?: ProjectSummary;
}

export type {RequirementDiscoveryResult} from '@agent-foreman/contracts';

export interface DraftPlanInput {
  readonly taskId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly userRequest: string;
  readonly discovery: RequirementDiscoveryResult;
}

export interface RevisePlanInput {
  readonly currentPlan: TaskPlan;
  readonly changeRequest: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface ReviewInput {
  readonly approvedPlan: TaskPlan;
  readonly approvedPlanHash: string;
  readonly workerResult: WorkerExecutionResult;
  readonly qualityGateReport: QualityGateReport;
  readonly relevantDiff: string;
  readonly previousDecision?: ReviewDecision;
}

export interface FinalReviewInput extends ReviewInput {
  readonly reviewDecision: ReviewDecision;
}

export interface SupervisorProvider {
  descriptor(): Promise<ProviderDescriptor>;
  healthCheck(): Promise<ProviderHealth>;
  discoverModels?(): Promise<ModelDescriptor[]>;
  analyzeRequirements(
    input: RequirementDiscoveryInput,
    context: ProviderExecutionContext,
  ): Promise<RequirementDiscoveryResult>;
  draftPlan(input: DraftPlanInput, context: ProviderExecutionContext): Promise<TaskPlan>;
  revisePlan(input: RevisePlanInput, context: ProviderExecutionContext): Promise<TaskPlan>;
  reviewImplementation(
    input: ReviewInput,
    context: ProviderExecutionContext,
  ): Promise<ReviewDecision>;
  finalReview(
    input: FinalReviewInput,
    context: ProviderExecutionContext,
  ): Promise<FinalReviewDecision>;
}

export interface WorkerProvider {
  descriptor(): Promise<ProviderDescriptor>;
  healthCheck(): Promise<ProviderHealth>;
  discoverModels?(): Promise<ModelDescriptor[]>;
  execute(
    input: WorkerExecutionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult>;
  revise(
    input: WorkerRevisionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult>;
  resume?(
    sessionId: string,
    input: WorkerRevisionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult>;
  cancel?(executionId: string): Promise<void>;
}
