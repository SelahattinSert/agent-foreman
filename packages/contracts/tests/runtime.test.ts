import {describe, expect, test} from 'vitest';

import {
  ApprovalChallengeSchema,
  RuntimeCommandEnvelopeSchema,
  RuntimeErrorEnvelopeSchema,
  SessionCreateInputSchema,
  WorkerStartInputSchema,
} from '../src/index.js';

const now = '2026-08-01T16:00:00.000Z';

describe('headless runtime contracts', () => {
  test('accepts an explicitly requested session with or without task text', () => {
    expect(
      SessionCreateInputSchema.parse({
        projectRoot: '/project',
        frontendProvider: 'codex-native',
        profileName: 'balanced',
      }),
    ).not.toHaveProperty('task');

    expect(
      SessionCreateInputSchema.parse({
        projectRoot: '/project',
        frontendProvider: 'codex-native',
        profileName: 'balanced',
        task: 'Add a subtract function.',
      }),
    ).toMatchObject({task: 'Add a subtract function.'});
  });

  test('rejects unknown command fields instead of silently accepting authority', () => {
    expect(() =>
      RuntimeCommandEnvelopeSchema.parse({
        schemaVersion: 1,
        requestId: 'request-001',
        command: 'session.create',
        input: {
          projectRoot: '/project',
          frontendProvider: 'codex-native',
          profileName: 'balanced',
        },
        autoApprove: true,
      }),
    ).toThrow();
  });

  test('requires worker execution to carry an exact SHA-256 plan hash', () => {
    expect(
      WorkerStartInputSchema.parse({
        sessionId: 'session-001',
        approvedPlanHash: 'a'.repeat(64),
      }),
    ).toEqual({sessionId: 'session-001', approvedPlanHash: 'a'.repeat(64)});

    expect(() =>
      WorkerStartInputSchema.parse({
        sessionId: 'session-001',
        approvedPlanHash: 'not-a-plan-hash',
      }),
    ).toThrow(/hash/iu);
  });

  test('binds approval challenges to one purpose, session, subject, and expiry', () => {
    expect(
      ApprovalChallengeSchema.parse({
        schemaVersion: 1,
        id: 'challenge-001',
        sessionId: 'session-001',
        purpose: 'PLAN',
        subjectHash: 'b'.repeat(64),
        planVersion: 1,
        createdAt: now,
        expiresAt: '2026-08-01T16:05:00.000Z',
        status: 'PENDING',
      }),
    ).toMatchObject({purpose: 'PLAN', status: 'PENDING'});

    expect(() =>
      ApprovalChallengeSchema.parse({
        schemaVersion: 1,
        id: 'challenge-001',
        sessionId: 'session-001',
        purpose: 'PLAN',
        subjectHash: 'b'.repeat(64),
        createdAt: now,
        status: 'PENDING',
      }),
    ).toThrow();
  });

  test('uses a stable error envelope without exposing internal causes', () => {
    expect(
      RuntimeErrorEnvelopeSchema.parse({
        schemaVersion: 1,
        requestId: 'request-001',
        ok: false,
        error: {
          code: 'PLAN_NOT_APPROVED',
          message: 'The worker requires an approved plan.',
          retryable: false,
          state: 'AWAITING_PLAN_REVIEW',
          diagnostics: {sessionId: 'session-001'},
        },
      }),
    ).toMatchObject({ok: false, error: {code: 'PLAN_NOT_APPROVED'}});

    expect(() =>
      RuntimeErrorEnvelopeSchema.parse({
        schemaVersion: 1,
        requestId: 'request-001',
        ok: false,
        error: {
          code: 'PROVIDER_FAILED',
          message: 'Provider failed.',
          retryable: true,
          cause: 'Bearer secret-token',
        },
      }),
    ).toThrow();
  });
});
