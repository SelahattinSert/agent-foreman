import {
  ReviewDecisionSchema,
  TaskPlanSchema,
  WorkerExecutionResultSchema,
  type FinalReviewDecision,
  type ProviderDescriptor,
  type ProviderHealth,
  type ReviewDecision,
  type TaskPlan,
  type WorkerExecutionInput,
  type WorkerExecutionResult,
  type WorkerRevisionInput,
} from '@agent-foreman/contracts';
import {ProviderExecutionError} from '@agent-foreman/core';

import type {ProviderExecutionContext} from '../context.js';
import type {
  DraftPlanInput,
  FinalReviewInput,
  RequirementDiscoveryInput,
  RequirementDiscoveryResult,
  ReviewInput,
  RevisePlanInput,
  SupervisorProvider,
  WorkerProvider,
} from '../provider.js';

const healthy: ProviderHealth = {status: 'PASS', message: 'Fixture provider is available.'};

const supervisorDescriptor: ProviderDescriptor = {
  id: 'fake-supervisor',
  displayName: 'Fake Supervisor',
  transport: 'sdk',
  capabilities: {
    supervisorPlanning: true,
    supervisorReview: true,
    workerExecution: false,
    structuredOutput: true,
    sessionResume: false,
    filesystemTools: false,
    shellTools: false,
    streaming: false,
    tokenUsageReporting: false,
    modelDiscovery: false,
  },
};

const workerDescriptor: ProviderDescriptor = {
  id: 'fake-worker',
  displayName: 'Fake Worker',
  transport: 'sdk',
  capabilities: {
    supervisorPlanning: false,
    supervisorReview: false,
    workerExecution: true,
    structuredOutput: true,
    sessionResume: false,
    filesystemTools: true,
    shellTools: true,
    streaming: false,
    tokenUsageReporting: false,
    modelDiscovery: false,
  },
};

const approvedReview = (): ReviewDecision => ({
  schemaVersion: 1,
  verdict: 'APPROVED',
  summary: 'Fixture review approved the implementation.',
  acceptanceCriteria: [],
  findings: [],
  resolvedFindingIds: [],
  openFindingIds: [],
  newFindingIds: [],
  scopeAssessment: {withinApprovedPlan: true, unexpectedChanges: []},
  recommendedNextAction: 'finish',
});

export interface FakeSupervisorOptions {
  readonly plans: readonly TaskPlan[];
  readonly discovery?: RequirementDiscoveryResult;
  readonly reviews?: readonly ReviewDecision[];
  readonly finalReviews?: readonly FinalReviewDecision[];
}

export class FakeSupervisorProvider implements SupervisorProvider {
  public readonly calls = {
    analyzeRequirements: [] as RequirementDiscoveryInput[],
    draftPlan: [] as DraftPlanInput[],
    revisePlan: [] as RevisePlanInput[],
    reviewImplementation: [] as ReviewInput[],
    finalReview: [] as FinalReviewInput[],
  };

  private planIndex = 0;
  private reviewIndex = 0;
  private finalReviewIndex = 0;

  public constructor(private readonly options: FakeSupervisorOptions) {}

  public async descriptor(): Promise<ProviderDescriptor> {
    return supervisorDescriptor;
  }

  public async healthCheck(): Promise<ProviderHealth> {
    return healthy;
  }

  public async analyzeRequirements(
    input: RequirementDiscoveryInput,
    _context: ProviderExecutionContext,
  ): Promise<RequirementDiscoveryResult> {
    this.calls.analyzeRequirements.push(input);
    return (
      this.options.discovery ?? {
        summary: input.userRequest,
        repositoryObservations: [],
        questions: [],
        proposedAssumptions: [],
        sufficient: true,
      }
    );
  }

  public async draftPlan(
    input: DraftPlanInput,
    _context: ProviderExecutionContext,
  ): Promise<TaskPlan> {
    this.calls.draftPlan.push(input);
    return this.takePlan();
  }

  public async revisePlan(
    input: RevisePlanInput,
    _context: ProviderExecutionContext,
  ): Promise<TaskPlan> {
    this.calls.revisePlan.push(input);
    return this.takePlan();
  }

  public async reviewImplementation(
    input: ReviewInput,
    _context: ProviderExecutionContext,
  ): Promise<ReviewDecision> {
    this.calls.reviewImplementation.push(input);
    const result = this.options.reviews?.[this.reviewIndex] ?? approvedReview();
    this.reviewIndex += 1;
    return ReviewDecisionSchema.parse(result);
  }

  public async finalReview(
    input: FinalReviewInput,
    _context: ProviderExecutionContext,
  ): Promise<FinalReviewDecision> {
    this.calls.finalReview.push(input);
    const result = this.options.finalReviews?.[this.finalReviewIndex] ?? approvedReview();
    this.finalReviewIndex += 1;
    return ReviewDecisionSchema.parse(result);
  }

  private takePlan(): TaskPlan {
    const plan = this.options.plans[this.planIndex];
    if (plan === undefined) {
      throw new ProviderExecutionError('Fake supervisor has no configured plan response.');
    }
    this.planIndex += 1;
    return TaskPlanSchema.parse(plan);
  }
}

const completedWorkerResult = (): WorkerExecutionResult => ({
  schemaVersion: 1,
  executionId: 'fake-execution',
  status: 'COMPLETED',
  summary: 'Fixture worker completed the approved plan.',
  changedFiles: [],
  commandsRun: [],
  testsAdded: [],
  acceptanceCriteriaWorkedOn: [],
  assumptionsMade: [],
  blockers: [],
  knownIssues: [],
});

export interface FakeWorkerOptions {
  readonly results?: readonly WorkerExecutionResult[];
}

export class FakeWorkerProvider implements WorkerProvider {
  public readonly calls = {
    execute: [] as WorkerExecutionInput[],
    revise: [] as WorkerRevisionInput[],
  };

  private resultIndex = 0;

  public constructor(private readonly options: FakeWorkerOptions = {}) {}

  public async descriptor(): Promise<ProviderDescriptor> {
    return workerDescriptor;
  }

  public async healthCheck(): Promise<ProviderHealth> {
    return healthy;
  }

  public async execute(
    input: WorkerExecutionInput,
    _context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult> {
    this.calls.execute.push(input);
    return this.takeResult();
  }

  public async revise(
    input: WorkerRevisionInput,
    _context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult> {
    this.calls.revise.push(input);
    return this.takeResult();
  }

  private takeResult(): WorkerExecutionResult {
    const result = this.options.results?.[this.resultIndex] ?? completedWorkerResult();
    this.resultIndex += 1;
    return WorkerExecutionResultSchema.parse(result);
  }
}
