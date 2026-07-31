import {describe, expect, test} from 'vitest';

import {
  ProviderDescriptorSchema,
  ReviewDecisionSchema,
  TaskPlanSchema,
  TaskSessionSchema,
  WorkerExecutionResultSchema,
  type TaskPlan,
} from '../src/index.js';

const now = '2026-07-31T12:00:00.000Z';

const validPlan = (): TaskPlan => ({
  schemaVersion: 1,
  taskId: 'task-001',
  version: 1,
  status: 'DRAFT',
  title: 'Add a guarded workflow',
  objective: 'Prevent execution before explicit approval.',
  userIntentSummary: 'Create a provider-neutral approval boundary.',
  assumptions: [
    {
      id: 'ASM-001',
      description: 'The repository uses Node.js 22.',
      status: 'ACCEPTED',
    },
  ],
  requirements: [
    {
      id: 'REQ-001',
      description: 'Worker execution requires an approved plan.',
      priority: 'must',
      source: 'user',
    },
  ],
  acceptanceCriteria: [
    {
      id: 'AC-001',
      description: 'A worker start attempt without approval fails.',
      verificationMethod: 'test',
      evidenceExpectation: 'A focused unit test throws PlanNotApprovedError.',
      priority: 'must',
    },
  ],
  implementationSteps: [
    {
      id: 'STEP-001',
      title: 'Add approval guard',
      description: 'Validate status, version, and hash before execution.',
      dependencies: [],
      expectedOutputs: ['Approval guard and unit tests'],
      allowedAreas: ['packages/core'],
      requiresUserDecision: false,
    },
  ],
  expectedFileAreas: ['packages/core'],
  verificationCommands: [
    {
      id: 'verify-tests',
      command: ['pnpm', 'test'],
      required: true,
      timeoutSeconds: 600,
    },
  ],
  risks: [
    {
      id: 'RISK-001',
      description: 'A mutable approved plan could bypass review.',
      likelihood: 'medium',
      impact: 'high',
      mitigation: 'Freeze and hash the canonical plan.',
    },
  ],
  outOfScope: ['Real provider calls'],
  userDecisions: [],
  createdAt: now,
});

describe('TaskPlanSchema', () => {
  test('accepts a structured draft plan', () => {
    expect(TaskPlanSchema.parse(validPlan())).toEqual(validPlan());
  });

  test('rejects unknown step dependencies', () => {
    const plan = validPlan();
    plan.implementationSteps[0]?.dependencies.push('STEP-404');

    expect(() => TaskPlanSchema.parse(plan)).toThrow(/STEP-404/u);
  });

  test('rejects duplicate acceptance criterion identifiers', () => {
    const plan = validPlan();
    const criterion = plan.acceptanceCriteria[0];
    if (criterion === undefined) throw new Error('fixture is missing AC-001');
    plan.acceptanceCriteria.push({...criterion});

    expect(() => TaskPlanSchema.parse(plan)).toThrow(/duplicate.*AC-001/iu);
  });
});

describe('boundary schemas', () => {
  test('rejects a session with an unknown workflow state', () => {
    expect(() =>
      TaskSessionSchema.parse({
        id: 'task-001',
        createdAt: now,
        updatedAt: now,
        projectRoot: '/repo',
        frontendProvider: 'frontend',
        supervisorProvider: 'supervisor',
        workerProvider: 'worker',
        profileName: 'balanced',
        state: 'EXECUTE_WITHOUT_APPROVAL',
        iteration: 0,
      }),
    ).toThrow();
  });

  test('rejects a changed file that escapes the workspace', () => {
    expect(() =>
      WorkerExecutionResultSchema.parse({
        schemaVersion: 1,
        executionId: 'exec-001',
        status: 'COMPLETED',
        summary: 'Changed a file.',
        changedFiles: [{path: '../outside.txt', changeType: 'modified'}],
        commandsRun: [],
        testsAdded: [],
        acceptanceCriteriaWorkedOn: ['AC-001'],
        assumptionsMade: [],
        blockers: [],
        knownIssues: [],
      }),
    ).toThrow(/relative workspace path/iu);
  });

  test('requires review finding lifecycle ids to reference findings', () => {
    expect(() =>
      ReviewDecisionSchema.parse({
        schemaVersion: 1,
        verdict: 'REVISE',
        summary: 'Revision required.',
        acceptanceCriteria: [],
        findings: [],
        resolvedFindingIds: [],
        openFindingIds: ['REV-404'],
        newFindingIds: [],
        scopeAssessment: {withinApprovedPlan: true, unexpectedChanges: []},
        recommendedNextAction: 'return_to_worker',
      }),
    ).toThrow(/REV-404/u);
  });

  test('accepts provider metadata without a hard-coded model', () => {
    expect(
      ProviderDescriptorSchema.parse({
        id: 'fixture-provider',
        displayName: 'Fixture Provider',
        transport: 'cli',
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
      }),
    ).toMatchObject({id: 'fixture-provider'});
  });
});
