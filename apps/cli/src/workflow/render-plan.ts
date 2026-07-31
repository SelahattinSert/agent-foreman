import type {TaskPlan} from '@agent-foreman/contracts';

const listOrNone = (items: readonly string[]): string =>
  items.length === 0 ? '- None' : items.map((item) => `- ${item}`).join('\n');

export const renderTaskPlanMarkdown = (
  plan: TaskPlan,
): string => `# Draft Plan v${String(plan.version)}

## Objective

${plan.objective}

## Acceptance criteria

${listOrNone(plan.acceptanceCriteria.map(({id, description}) => `${id}: ${description}`))}

## Implementation steps

${listOrNone(plan.implementationSteps.map(({id, title}) => `${id}: ${title}`))}

## Out of scope

${listOrNone(plan.outOfScope)}

## Risks

${listOrNone(plan.risks.map(({id, description}) => `${id}: ${description}`))}
`;
