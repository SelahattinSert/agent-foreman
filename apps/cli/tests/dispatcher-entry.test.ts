import {describe, expect, test, vi} from 'vitest';

import type {ShimMetadata} from '@agent-foreman/process';

import {parseDispatcherArguments, runDispatcherEntry} from '../src/dispatcher-entry.js';

const metadata: ShimMetadata = {
  version: 1,
  providerId: 'codex',
  binaryName: 'codex',
  realBinaryPath: '/real/codex',
  dispatcherEntrypoint: '/agent-foreman/dispatcher.js',
  nodeExecutable: '/node',
  installedAt: '2026-07-31T00:00:00.000Z',
  files: [],
};

describe('dispatcher entry', () => {
  test('parses the private metadata envelope without changing provider args', () => {
    expect(
      parseDispatcherArguments(['--metadata', '/data/codex.json', '--', 'exec', 'space kept']),
    ).toEqual({
      metadataPath: '/data/codex.json',
      providerArguments: ['exec', 'space kept'],
    });
  });

  test('loads trusted install metadata and passes normal commands to the real binary', async () => {
    const runPassthrough = vi.fn(async () => 42);
    const runAgentForeman = vi.fn(async () => 0);
    const exitCode = await runDispatcherEntry(
      ['--metadata', '/data/codex.json', '--', '--help'],
      {},
      {
        loadMetadata: vi.fn(async () => metadata),
        runAgentForeman,
        runPassthrough,
      },
    );

    expect(exitCode).toBe(42);
    expect(runPassthrough).toHaveBeenCalledWith({
      executable: '/real/codex',
      args: ['--help'],
      environment: {AGENT_FOREMAN_DISPATCH_DEPTH: '1'},
    });
    expect(runAgentForeman).not.toHaveBeenCalled();
  });

  test('starts Agent Foreman with the frontend provider and remaining args', async () => {
    const runAgentForeman = vi.fn(async () => 0);
    await runDispatcherEntry(
      ['--metadata', '/data/codex.json', '--', 'agent-foreman', '--plain'],
      {},
      {
        loadMetadata: vi.fn(async () => metadata),
        runAgentForeman,
        runPassthrough: vi.fn(async () => 1),
      },
    );

    expect(runAgentForeman).toHaveBeenCalledWith('codex', ['--plain']);
  });
});
