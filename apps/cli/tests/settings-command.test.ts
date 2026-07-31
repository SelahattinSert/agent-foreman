import {describe, expect, test, vi} from 'vitest';

import {resolveConfig, type ResolvedConfig} from '@agent-foreman/config';

import {ensureConfiguredProfile, runSettingsCommand} from '../src/commands/settings.js';

const completeConfig = resolveConfig({
  global: {
    version: 1,
    activeProfile: 'daily',
    profiles: {
      daily: {
        supervisor: {provider: 'codex-cli', model: 'supervisor-model'},
        worker: {provider: 'gemini-cli', model: 'worker-model'},
      },
    },
  },
});

const incompleteConfig = resolveConfig({});

describe('runSettingsCommand', () => {
  test('routes TTY settings to Ink and non-TTY settings to redacted read-only output', async () => {
    const runTui = vi.fn(() => Promise.resolve({kind: 'saved' as const, profileName: 'daily'}));
    const showReadonly = vi.fn(() => Promise.resolve());

    await runSettingsCommand({interactive: true, projectRoot: '/project', noColor: true}, vi.fn(), {
      runTui,
      showReadonly,
    });
    expect(runTui).toHaveBeenCalledOnce();
    expect(showReadonly).not.toHaveBeenCalled();

    await runSettingsCommand(
      {interactive: false, projectRoot: '/project', noColor: true},
      vi.fn(),
      {runTui, showReadonly},
    );
    expect(showReadonly).toHaveBeenCalledOnce();
    expect(runTui).toHaveBeenCalledOnce();
  });
});

describe('ensureConfiguredProfile', () => {
  test('runs setup before a task and reloads the explicitly saved global profile', async () => {
    const load = vi
      .fn<(input: unknown) => Promise<ResolvedConfig>>()
      .mockResolvedValueOnce(incompleteConfig)
      .mockResolvedValueOnce(completeConfig);
    const setup = vi.fn(() => Promise.resolve({kind: 'saved' as const, profileName: 'daily'}));

    const result = await ensureConfiguredProfile(
      {
        projectRoot: '/project',
        cli: {},
        interactive: true,
        output: 'human',
        noColor: true,
      },
      {load, setup},
    );

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({projectRoot: '/project', initialProfile: 'balanced'}),
    );
    expect(load).toHaveBeenLastCalledWith({
      projectRoot: '/project',
      cli: {profileName: 'daily'},
    });
    expect(result).toBe(completeConfig);
  });

  test('bypasses setup for complete profiles', async () => {
    const load = vi.fn(() => Promise.resolve(completeConfig));
    const setup = vi.fn();

    await expect(
      ensureConfiguredProfile(
        {
          projectRoot: '/project',
          cli: {},
          interactive: true,
          output: 'human',
          noColor: false,
        },
        {load, setup},
      ),
    ).resolves.toBe(completeConfig);
    expect(setup).not.toHaveBeenCalled();
  });

  test('rejects incomplete non-interactive and cancelled setup before runtime starts', async () => {
    const load = vi.fn(() => Promise.resolve(incompleteConfig));
    await expect(
      ensureConfiguredProfile(
        {
          projectRoot: '/project',
          cli: {},
          interactive: false,
          output: 'human',
          noColor: true,
        },
        {load, setup: vi.fn()},
      ),
    ).rejects.toThrow(/af settings/iu);

    await expect(
      ensureConfiguredProfile(
        {
          projectRoot: '/project',
          cli: {},
          interactive: true,
          output: 'human',
          noColor: true,
        },
        {load, setup: vi.fn(() => Promise.resolve({kind: 'cancelled' as const}))},
      ),
    ).rejects.toThrow(/cancelled/iu);
  });
});
