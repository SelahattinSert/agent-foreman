import type {Interface} from 'node:readline/promises';

import {describe, expect, test} from 'vitest';

import type {TaskPlan} from '@agent-foreman/contracts';

import {PlainWorkflowInteraction} from '../src/workflow/plain-interaction.js';

const plan: TaskPlan = {
  schemaVersion: 1,
  taskId: 'task-json',
  version: 1,
  status: 'DRAFT',
  title: 'JSON output',
  objective: 'Keep stdout parseable.',
  userIntentSummary: 'Emit JSONL events.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [],
  implementationSteps: [],
  expectedFileAreas: [],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: '2026-07-31T12:00:00.000Z',
};

const terminalWith = (answers: readonly string[]): Interface => {
  let index = 0;
  return {
    question: () => Promise.resolve(answers[index++] ?? '/cancel'),
  } as unknown as Interface;
};

describe('plain JSON output', () => {
  test('writes machine-parseable one-line events and still requires exact approval', async () => {
    const output: string[] = [];
    const interaction = new PlainWorkflowInteraction({
      terminal: terminalWith(['/show-json', 'tamam']),
      write: (message) => output.push(message),
      json: true,
    });

    await expect(interaction.reviewPlan(plan)).resolves.toEqual({
      kind: 'request-change',
      message: 'Discussion: tamam',
    });
    const lines = output.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({event: 'plan.review', plan}),
      {event: 'plan.json', plan},
    ]);
  });
});
