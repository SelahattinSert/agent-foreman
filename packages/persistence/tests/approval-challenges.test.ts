import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import type {ApprovalChallenge, TaskSession} from '@agent-foreman/contracts';

import {
  InMemoryWorkflowStore,
  SqliteWorkflowStore,
  type ApprovalChallengeRepository,
} from '../src/index.js';

const createdAt = '2026-08-01T16:00:00.000Z';
const consumedAt = '2026-08-01T16:01:00.000Z';

const session: TaskSession = {
  id: 'session-approval-001',
  createdAt,
  updatedAt: createdAt,
  projectRoot: '/project',
  frontendProvider: 'codex-native',
  supervisorProvider: 'codex-native',
  workerProvider: 'fixture-worker',
  profileName: 'balanced',
  state: 'CREATED',
  iteration: 0,
};

const challenge = (overrides: Partial<ApprovalChallenge> = {}): ApprovalChallenge => ({
  schemaVersion: 1,
  id: 'challenge-001',
  sessionId: session.id,
  purpose: 'PLAN',
  subjectHash: 'a'.repeat(64),
  planVersion: 1,
  createdAt,
  expiresAt: '2026-08-01T16:05:00.000Z',
  status: 'PENDING',
  ...overrides,
});

interface StoreHandle {
  readonly store: ApprovalChallengeRepository & {
    createSession(value: TaskSession): Promise<void>;
  };
  close(): void;
}

const inMemoryStore = async (): Promise<StoreHandle> => {
  const store = new InMemoryWorkflowStore();
  await store.createSession(session);
  return {store, close: () => undefined};
};

const sqliteStore = async (): Promise<StoreHandle> => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-approval-'));
  const store = await SqliteWorkflowStore.open({databasePath: path.join(root, 'state.sqlite3')});
  await store.createSession(session);
  return {
    store,
    close: () => {
      store.close();
    },
  };
};

const stores = [
  ['in-memory', inMemoryStore],
  ['sqlite', sqliteStore],
] as const;

describe.each(stores)('%s approval challenge repository', (_name, createStore) => {
  test('atomically consumes an exact pending challenge once', async () => {
    const handle = await createStore();
    try {
      await handle.store.createApprovalChallenge(challenge());

      await expect(
        handle.store.consumeApprovalChallenge({
          challengeId: 'challenge-001',
          sessionId: session.id,
          purpose: 'PLAN',
          subjectHash: 'a'.repeat(64),
          consumedAt,
        }),
      ).resolves.toMatchObject({status: 'CONSUMED', consumedAt});

      await expect(
        handle.store.consumeApprovalChallenge({
          challengeId: 'challenge-001',
          sessionId: session.id,
          purpose: 'PLAN',
          subjectHash: 'a'.repeat(64),
          consumedAt,
        }),
      ).rejects.toThrow(/already used|pending/iu);
    } finally {
      handle.close();
    }
  });

  test('rejects the wrong session, purpose, or subject hash without consuming', async () => {
    const handle = await createStore();
    try {
      await handle.store.createApprovalChallenge(challenge());

      for (const mismatch of [
        {sessionId: 'another-session', purpose: 'PLAN' as const, subjectHash: 'a'.repeat(64)},
        {sessionId: session.id, purpose: 'APPLY' as const, subjectHash: 'a'.repeat(64)},
        {sessionId: session.id, purpose: 'PLAN' as const, subjectHash: 'b'.repeat(64)},
      ]) {
        await expect(
          handle.store.consumeApprovalChallenge({
            challengeId: 'challenge-001',
            ...mismatch,
            consumedAt,
          }),
        ).rejects.toThrow(/does not match|authorization/iu);
      }

      await expect(handle.store.getApprovalChallenge('challenge-001')).resolves.toMatchObject({
        status: 'PENDING',
      });
    } finally {
      handle.close();
    }
  });

  test('rejects an expired or cancelled challenge', async () => {
    const handle = await createStore();
    try {
      await handle.store.createApprovalChallenge(
        challenge({expiresAt: '2026-08-01T16:00:30.000Z'}),
      );
      await expect(
        handle.store.consumeApprovalChallenge({
          challengeId: 'challenge-001',
          sessionId: session.id,
          purpose: 'PLAN',
          subjectHash: 'a'.repeat(64),
          consumedAt,
        }),
      ).rejects.toThrow(/expired/iu);

      await handle.store.createApprovalChallenge(challenge({id: 'challenge-002'}));
      await handle.store.cancelApprovalChallenge('challenge-002', session.id);
      await expect(
        handle.store.consumeApprovalChallenge({
          challengeId: 'challenge-002',
          sessionId: session.id,
          purpose: 'PLAN',
          subjectHash: 'a'.repeat(64),
          consumedAt,
        }),
      ).rejects.toThrow(/already used|pending/iu);
    } finally {
      handle.close();
    }
  });

  test('replaces an older pending challenge without leaving two usable approvals', async () => {
    const handle = await createStore();
    try {
      await handle.store.createApprovalChallenge(challenge());
      await handle.store.createApprovalChallenge(
        challenge({id: 'challenge-002', subjectHash: 'b'.repeat(64)}),
      );

      await expect(handle.store.getApprovalChallenge('challenge-001')).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      await expect(handle.store.getApprovalChallenge('challenge-002')).resolves.toMatchObject({
        status: 'PENDING',
        subjectHash: 'b'.repeat(64),
      });
    } finally {
      handle.close();
    }
  });
});

test('SQLite approval challenges survive reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-approval-resume-'));
  const databasePath = path.join(root, 'state.sqlite3');
  const first = await SqliteWorkflowStore.open({databasePath});
  await first.createSession(session);
  await first.createApprovalChallenge(challenge());
  first.close();

  const reopened = await SqliteWorkflowStore.open({databasePath});
  await expect(reopened.getApprovalChallenge('challenge-001')).resolves.toEqual(challenge());
  reopened.close();
});
