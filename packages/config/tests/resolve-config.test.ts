import {describe, expect, test} from 'vitest';

import {resolveConfig} from '../src/index.js';

describe('resolveConfig', () => {
  test('applies CLI, project, selected profile, global, and safe defaults in order', () => {
    const resolved = resolveConfig({
      global: {
        version: 1,
        activeProfile: 'balanced',
        general: {logLevel: 'warn', telemetry: true},
        profiles: {
          balanced: {
            supervisor: {provider: 'fixture-supervisor', model: 'configured-supervisor'},
            worker: {provider: 'global-worker', model: 'configured-worker'},
          },
        },
      },
      project: {
        version: 1,
        general: {logLevel: 'debug'},
        workflow: {maxWorkerIterations: 4},
        quality: {allowOpenMedium: false},
      },
      cli: {
        workerProvider: 'cli-worker',
      },
    });

    expect(resolved.activeProfile).toBe('balanced');
    expect(resolved.general).toMatchObject({logLevel: 'debug', telemetry: true});
    expect(resolved.workspace.mode).toBe('smart');
    expect(resolved.planning.networkAccess).toBe(false);
    expect(resolved.workflow).toMatchObject({maxWorkerIterations: 4, maxMechanicalRepairs: 3});
    expect(resolved.quality).toMatchObject({allowOpenMedium: false, allowOpenLow: true});
    expect(resolved.supervisor).toEqual({
      provider: 'fixture-supervisor',
      model: 'configured-supervisor',
    });
    expect(resolved.worker).toEqual({provider: 'cli-worker', model: 'configured-worker'});
  });

  test('does not invent a model when the selected profile omits it', () => {
    const resolved = resolveConfig({
      global: {
        version: 1,
        activeProfile: 'manual-model',
        profiles: {
          'manual-model': {
            supervisor: {provider: 'fixture-supervisor'},
            worker: {provider: 'fixture-worker'},
          },
        },
      },
    });

    expect(resolved.supervisor.model).toBeUndefined();
    expect(resolved.worker.model).toBeUndefined();
  });

  test('fails clearly when the selected profile does not exist', () => {
    expect(() =>
      resolveConfig({
        global: {version: 1, activeProfile: 'missing', profiles: {}},
      }),
    ).toThrow(/profile missing/iu);
  });
});
