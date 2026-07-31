import {describe, expect, test} from 'vitest';

import type {ReviewDecision, TaskPlan} from '@agent-foreman/contracts';

import {
  LoopProtectionError,
  WorkflowLoopGuard,
  assertReviewMayApprove,
  validateFindingLifecycle,
} from '../src/index.js';

const plan: TaskPlan = {
  schemaVersion: 1,
  taskId: 'task-001',
  version: 1,
  status: 'APPROVED',
  title: 'Guard the workflow',
  objective: 'Stop unsafe approvals and non-progress loops.',
  userIntentSummary: 'Exercise deterministic review policy.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [
    {
      id: 'AC-001',
      description: 'Required behavior works.',
      verificationMethod: 'test',
      evidenceExpectation: 'A passing test.',
      priority: 'must',
    },
  ],
  implementationSteps: [],
  expectedFileAreas: ['packages/core'],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: '2026-07-31T12:00:00.000Z',
  approvedAt: '2026-07-31T12:01:00.000Z',
};

const decision = (overrides: Partial<ReviewDecision> = {}): ReviewDecision => ({
  schemaVersion: 1,
  verdict: 'APPROVED',
  summary: 'Implementation is acceptable.',
  acceptanceCriteria: [
    {
      acceptanceCriterionId: 'AC-001',
      status: 'PASSED',
      summary: 'Verified.',
      evidence: [{kind: 'test', reference: 'pnpm test'}],
    },
  ],
  findings: [],
  resolvedFindingIds: [],
  openFindingIds: [],
  newFindingIds: [],
  scopeAssessment: {withinApprovedPlan: true, unexpectedChanges: []},
  recommendedNextAction: 'finish',
  ...overrides,
});

describe('review policy', () => {
  test('rejects approval when a must criterion failed or a required gate failed', () => {
    const failedCriterion = decision({
      acceptanceCriteria: [
        {
          acceptanceCriterionId: 'AC-001',
          status: 'FAILED',
          summary: 'Not working.',
          evidence: [],
        },
      ],
    });

    expect(() => {
      assertReviewMayApprove(failedCriterion, plan, true);
    }).toThrow(/AC-001/iu);
    expect(() => {
      assertReviewMayApprove(decision(), plan, false);
    }).toThrow(/quality gate/iu);
  });

  test('rejects approval with open high findings or important out-of-plan changes', () => {
    const finding = {
      id: 'REV-001',
      severity: 'high' as const,
      category: 'correctness' as const,
      title: 'Incorrect result',
      problem: 'The result is incorrect.',
      evidence: [{kind: 'diff' as const, reference: 'src/index.ts'}],
      requiredChange: 'Correct the result.',
      verification: 'Run the test.',
      relatedAcceptanceCriteria: ['AC-001'],
    };

    expect(() => {
      assertReviewMayApprove(
        decision({findings: [finding], openFindingIds: ['REV-001']}),
        plan,
        true,
      );
    }).toThrow(/REV-001/iu);
    expect(() => {
      assertReviewMayApprove(
        decision({
          scopeAssessment: {withinApprovedPlan: false, unexpectedChanges: ['Changed CI secrets.']},
        }),
        plan,
        true,
      );
    }).toThrow(/approved plan/iu);
  });

  test('allows medium findings only when the configured review policy permits them', () => {
    const finding = {
      id: 'REV-002',
      severity: 'medium' as const,
      category: 'maintainability' as const,
      title: 'Maintainability concern',
      problem: 'The implementation has avoidable complexity.',
      evidence: [{kind: 'diff' as const, reference: 'src/index.ts'}],
      requiredChange: 'Simplify the implementation.',
      verification: 'Review the revised diff.',
      relatedAcceptanceCriteria: ['AC-001'],
    };
    const withMedium = decision({findings: [finding], openFindingIds: ['REV-002']});

    expect(() => {
      assertReviewMayApprove(withMedium, plan, true, {
        allowOpenMedium: true,
        allowOpenLow: true,
      });
    }).not.toThrow();
    expect(() => {
      assertReviewMayApprove(withMedium, plan, true, {
        allowOpenMedium: false,
        allowOpenLow: true,
      });
    }).toThrow(/REV-002/iu);
  });

  test('requires every previous open finding to stay open or be explicitly resolved', () => {
    expect(() => {
      validateFindingLifecycle(['REV-001'], decision());
    }).toThrow(/REV-001/iu);
    expect(() => {
      validateFindingLifecycle(
        ['REV-001'],
        decision({
          findings: [
            {
              id: 'REV-001',
              severity: 'medium',
              category: 'testing',
              title: 'Missing edge case',
              problem: 'An edge case was missing.',
              evidence: [{kind: 'test', reference: 'tests/edge.test.ts'}],
              requiredChange: 'Add the test.',
              verification: 'Run the test.',
              relatedAcceptanceCriteria: ['AC-001'],
            },
          ],
          resolvedFindingIds: ['REV-001'],
        }),
      );
    }).not.toThrow();
  });
});

describe('WorkflowLoopGuard', () => {
  const createGuard = (): WorkflowLoopGuard =>
    new WorkflowLoopGuard({
      maxWorkerIterations: 8,
      maxMechanicalRepairs: 3,
      maxSupervisorReviews: 5,
      maxSameFindingOccurrences: 2,
      pauseOnNoProgressIterations: 2,
      detectDiffOscillation: true,
    });

  test('detects A/B/A diff oscillation and identical provider responses', () => {
    const guard = createGuard();
    guard.recordDiff('aaa');
    guard.recordDiff('bbb');
    expect(() => {
      guard.recordDiff('aaa');
    }).toThrow(LoopProtectionError);

    const responses = createGuard();
    responses.recordProviderResponse('same');
    expect(() => {
      responses.recordProviderResponse('same');
    }).toThrow(/same response/iu);
  });

  test('detects repeated gate failures and reviews without finding-count progress', () => {
    const gates = createGuard();
    gates.recordGateFailures(['lint:1']);
    expect(() => {
      gates.recordGateFailures(['lint:1']);
    }).toThrow(/quality gate/iu);

    const findings = createGuard();
    findings.recordReview(['REV-001', 'REV-002']);
    findings.recordReview(['REV-001', 'REV-002']);
    expect(() => {
      findings.recordReview(['REV-001', 'REV-002']);
    }).toThrow(/progress/iu);
  });

  test('enforces iteration, repair, review, and finding occurrence budgets', () => {
    const guard = new WorkflowLoopGuard({
      maxWorkerIterations: 1,
      maxMechanicalRepairs: 1,
      maxSupervisorReviews: 1,
      maxSameFindingOccurrences: 1,
      pauseOnNoProgressIterations: 2,
      detectDiffOscillation: false,
    });

    guard.recordWorkerIteration();
    expect(() => {
      guard.recordWorkerIteration();
    }).toThrow(/worker iteration/iu);
    guard.recordMechanicalRepair();
    expect(() => {
      guard.recordMechanicalRepair();
    }).toThrow(/mechanical repair/iu);
    guard.recordSupervisorReview();
    expect(() => {
      guard.recordSupervisorReview();
    }).toThrow(/supervisor review/iu);
    guard.recordFindingOccurrences(['REV-001']);
    expect(() => {
      guard.recordFindingOccurrences(['REV-001']);
    }).toThrow(/REV-001/iu);
  });
});
