import {describe, expect, test, vi} from 'vitest';

import {dispatchProviderInvocation} from '../src/index.js';

describe('dispatchProviderInvocation', () => {
  test('invokes Agent Foreman only for the exact intercepted subcommand', async () => {
    const runAgentForeman = vi.fn(async () => 7);
    const runPassthrough = vi.fn(async () => 11);

    const exitCode = await dispatchProviderInvocation(
      {
        args: ['agent-foreman', '--plain'],
        dispatchDepth: 0,
        frontendProvider: 'codex',
        realBinaryPath: '/real/codex',
      },
      {runAgentForeman, runPassthrough},
    );

    expect(exitCode).toBe(7);
    expect(runAgentForeman).toHaveBeenCalledWith('codex', ['--plain']);
    expect(runPassthrough).not.toHaveBeenCalled();
  });

  test('preserves executable, arguments, environment and exit code for passthrough', async () => {
    const runAgentForeman = vi.fn(async () => 7);
    const runPassthrough = vi.fn(async () => 29);

    const exitCode = await dispatchProviderInvocation(
      {
        args: ['exec', 'Fix the tests'],
        dispatchDepth: 0,
        frontendProvider: 'codex',
        realBinaryPath: '/real/codex',
      },
      {runAgentForeman, runPassthrough},
    );

    expect(exitCode).toBe(29);
    expect(runPassthrough).toHaveBeenCalledWith({
      executable: '/real/codex',
      args: ['exec', 'Fix the tests'],
      environment: {AGENT_FOREMAN_DISPATCH_DEPTH: '1'},
    });
    expect(runAgentForeman).not.toHaveBeenCalled();
  });
});
