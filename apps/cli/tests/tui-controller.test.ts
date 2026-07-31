import {describe, expect, test} from 'vitest';

import type {TaskPlan} from '@agent-foreman/contracts';

import {InkWorkflowController} from '../src/tui/workflow-tui.js';

const plan: TaskPlan = {
  schemaVersion: 1,
  taskId: 'task-tui',
  version: 1,
  status: 'DRAFT',
  title: 'TUI plan',
  objective: 'Verify explicit actions.',
  userIntentSummary: 'Do not treat natural language as approval.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [],
  implementationSteps: [],
  expectedFileAreas: ['src'],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: '2026-07-31T12:00:00.000Z',
};

describe('InkWorkflowController', () => {
  test('requires /approve and maps discussion to a supervised plan revision', async () => {
    const controller = new InkWorkflowController();
    const ambiguous = controller.reviewPlan(plan);
    controller.submit('tamam');
    await expect(ambiguous).resolves.toEqual({
      kind: 'request-change',
      message: 'Discussion: tamam',
    });

    const approval = controller.reviewPlan(plan);
    controller.submit('/approve');
    await expect(approval).resolves.toEqual({kind: 'approve'});

    const discussion = controller.reviewPlan(plan);
    controller.submit('/discuss keep the public API stable');
    await expect(discussion).resolves.toEqual({
      kind: 'request-change',
      message: 'Discussion: keep the public API stable',
    });
  });

  test('requires a second Ctrl+C action before cancelling a pending interaction', async () => {
    const controller = new InkWorkflowController();
    const review = controller.reviewPlan(plan);

    expect(controller.shortcut('cancel')).toBe(false);
    expect(controller.shortcut('cancel')).toBe(true);
    await expect(review).resolves.toEqual({kind: 'cancel'});
  });
});
