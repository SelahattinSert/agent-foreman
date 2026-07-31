import type {ReviewDecision, TaskPlan} from '@agent-foreman/contracts';

import {ProviderOutputValidationError} from '../errors/index.js';

export interface ReviewApprovalPolicy {
  readonly allowOpenMedium: boolean;
  readonly allowOpenLow: boolean;
}

const defaultPolicy: ReviewApprovalPolicy = {
  allowOpenMedium: true,
  allowOpenLow: true,
};

export const validateFindingLifecycle = (
  previousOpenFindingIds: readonly string[],
  decision: ReviewDecision,
): void => {
  const open = new Set(decision.openFindingIds);
  const resolved = new Set(decision.resolvedFindingIds);
  const newIds = new Set(decision.newFindingIds);
  const findingIds = new Set(decision.findings.map(({id}) => id));

  for (const id of previousOpenFindingIds) {
    if (!open.has(id) && !resolved.has(id)) {
      throw new ProviderOutputValidationError(
        `Supervisor omitted previous finding ${id}; it must remain open or be explicitly resolved.`,
      );
    }
    if (newIds.has(id)) {
      throw new ProviderOutputValidationError(
        `Supervisor marked existing finding ${id} as new. Finding IDs must remain stable.`,
      );
    }
  }

  for (const id of open) {
    if (!findingIds.has(id)) {
      throw new ProviderOutputValidationError(`Open finding ${id} has no finding payload.`);
    }
  }
};

export const assertReviewMayApprove = (
  decision: ReviewDecision,
  plan: TaskPlan,
  requiredQualityGatesPassed: boolean,
  policy: ReviewApprovalPolicy = defaultPolicy,
): void => {
  if (decision.verdict !== 'APPROVED') return;
  if (!requiredQualityGatesPassed) {
    throw new ProviderOutputValidationError(
      'Supervisor cannot approve while a required quality gate is failing.',
    );
  }
  if (!decision.scopeAssessment.withinApprovedPlan) {
    throw new ProviderOutputValidationError(
      'Supervisor cannot approve important changes outside the approved plan.',
      {diagnostics: {unexpectedChanges: decision.scopeAssessment.unexpectedChanges}},
    );
  }

  const reviews = new Map(
    decision.acceptanceCriteria.map((review) => [review.acceptanceCriterionId, review]),
  );
  for (const criterion of plan.acceptanceCriteria) {
    const review = reviews.get(criterion.id);
    if (criterion.priority === 'must' && review?.status !== 'PASSED') {
      throw new ProviderOutputValidationError(
        `Supervisor cannot approve because must acceptance criterion ${criterion.id} did not pass.`,
      );
    }
  }

  const openIds = new Set(decision.openFindingIds);
  for (const finding of decision.findings) {
    if (!openIds.has(finding.id)) continue;
    const blocks =
      finding.severity === 'critical' ||
      finding.severity === 'high' ||
      (finding.severity === 'medium' && !policy.allowOpenMedium) ||
      (finding.severity === 'low' && !policy.allowOpenLow) ||
      finding.category === 'security';
    if (blocks) {
      throw new ProviderOutputValidationError(
        `Supervisor cannot approve with blocking finding ${finding.id} still open.`,
      );
    }
  }
};
