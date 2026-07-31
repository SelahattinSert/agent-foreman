import {describe, expect, test, vi} from 'vitest';

import type {ConfigDocument} from '@agent-foreman/config';

import {
  SettingsController,
  type SettingsControllerDependencies,
} from '../src/settings/settings-controller.js';
import type {SettingsDraft} from '../src/settings/profile-service.js';
import type {SettingsValidation} from '../src/settings/provider-catalog.js';

const emptyDocument: ConfigDocument = {version: 1};

const validation = (status: SettingsValidation['status']): SettingsValidation => ({
  status,
  checks: [
    {
      role: 'supervisor',
      status: status === 'FAIL' ? 'FAIL' : status,
      message: `Supervisor ${status}`,
    },
    {role: 'worker', status: status === 'FAIL' ? 'PASS' : status, message: `Worker ${status}`},
  ],
  workerModels: [],
});

const dependencies = (
  status: SettingsValidation['status'] = 'PASS',
  document: ConfigDocument = emptyDocument,
): SettingsControllerDependencies & {
  readonly save: ReturnType<typeof vi.fn>;
  readonly discoverWorkerModels: ReturnType<typeof vi.fn>;
} => {
  const save = vi.fn(async (_draft: SettingsDraft) => undefined);
  return {
    service: {load: vi.fn(async () => document), save},
    validate: vi.fn(async () => validation(status)),
    discoverWorkerModels: vi.fn(async () => []),
    save,
  };
};

const choose = async (controller: SettingsController, id: string): Promise<void> => {
  const choices = controller.getSnapshot().choices;
  const target = choices.findIndex((choice) => choice.id === id);
  if (target < 0) throw new Error(`Choice ${id} is unavailable.`);
  while (controller.getSnapshot().selectedIndex !== target) controller.move(1);
  await controller.submit();
};

const enter = async (controller: SettingsController, value: string): Promise<void> => {
  controller.type(value);
  await controller.submit();
};

const reachValidation = async (controller: SettingsController): Promise<void> => {
  await controller.initialize();
  await choose(controller, 'create-profile');
  await enter(controller, 'daily');
  await choose(controller, 'codex-cli');
  await enter(controller, 'supervisor-model');
  await choose(controller, 'high');
  await choose(controller, 'gemini-cli');
  await enter(controller, 'worker-model');
  expect(controller.getSnapshot().step).toBe('validation');
};

describe('SettingsController', () => {
  test('selects create-profile when the requested first-run profile does not exist globally', async () => {
    const deps = dependencies('PASS', {
      version: 1,
      activeProfile: 'legacy',
      profiles: {
        legacy: {
          supervisor: {provider: 'codex-cli', model: 'legacy-supervisor'},
          worker: {provider: 'gemini-cli', model: 'legacy-worker'},
        },
      },
    });
    const controller = new SettingsController({...deps, initialProfile: 'balanced'});

    await controller.initialize();

    expect(controller.getSnapshot().choices[controller.getSnapshot().selectedIndex]?.id).toBe(
      'create-profile',
    );
    await controller.submit();
    expect(controller.getSnapshot()).toMatchObject({step: 'profile-name', input: 'balanced'});
  });

  test('collects fields in order and saves only through the explicit review action', async () => {
    const deps = dependencies();
    const controller = new SettingsController(deps);
    await reachValidation(controller);
    expect(deps.save).not.toHaveBeenCalled();

    await choose(controller, 'continue');
    expect(controller.getSnapshot().step).toBe('review');
    expect(controller.getSnapshot().selectedIndex).toBe(0);
    expect(controller.getSnapshot().choices[0]?.id).toBe('back');
    expect(deps.save).not.toHaveBeenCalled();

    await choose(controller, 'save');
    await expect(controller.waitForResult()).resolves.toEqual({
      kind: 'saved',
      profileName: 'daily',
    });
    expect(deps.save).toHaveBeenCalledOnce();
    expect(deps.save).toHaveBeenCalledWith({
      profileName: 'daily',
      supervisorProvider: 'codex-cli',
      supervisorModel: 'supervisor-model',
      reasoningEffort: 'high',
      workerProvider: 'gemini-cli',
      workerModel: 'worker-model',
    });
  });

  test('blocks FAIL and requires a second explicit choice for WARN', async () => {
    const failedDeps = dependencies('FAIL');
    const failed = new SettingsController(failedDeps);
    await reachValidation(failed);
    expect(failed.getSnapshot()).toMatchObject({step: 'validation', saveEligible: false});
    expect(failed.getSnapshot().choices.map(({id}) => id)).toEqual(['retry', 'edit']);
    expect(failedDeps.save).not.toHaveBeenCalled();

    const warnedDeps = dependencies('WARN');
    const warned = new SettingsController(warnedDeps);
    await reachValidation(warned);
    await choose(warned, 'continue');
    expect(warned.getSnapshot().step).toBe('warning-confirmation');
    expect(warned.getSnapshot().choices[0]?.id).toBe('back');
    expect(warnedDeps.save).not.toHaveBeenCalled();
    await choose(warned, 'confirm-warning');
    expect(warned.getSnapshot().step).toBe('review');
    expect(warnedDeps.save).not.toHaveBeenCalled();
  });

  test('preloads an existing profile and offers discovered worker models', async () => {
    const deps = dependencies('PASS', {
      version: 1,
      activeProfile: 'existing',
      profiles: {
        existing: {
          supervisor: {provider: 'codex-cli', model: 'existing-supervisor'},
          worker: {provider: 'gemini-cli', model: 'existing-worker'},
        },
      },
    });
    deps.discoverWorkerModels.mockResolvedValue([
      {id: 'gemini-fast', displayName: 'Gemini Fast', available: true},
    ]);
    const controller = new SettingsController(deps);
    await controller.initialize();
    await choose(controller, 'profile:existing');
    await choose(controller, 'codex-cli');
    expect(controller.getSnapshot().input).toBe('existing-supervisor');
    await controller.submit();
    await choose(controller, 'high');
    await choose(controller, 'gemini-cli');
    expect(controller.getSnapshot().step).toBe('worker-model-choice');
    expect(controller.getSnapshot().choices.map(({id}) => id)).toEqual([
      'model:gemini-fast',
      'manual-model',
    ]);
    expect(controller.getSnapshot().selectedIndex).toBe(1);
  });

  test('Escape cancels without writing', async () => {
    const deps = dependencies();
    const controller = new SettingsController(deps);
    await controller.initialize();
    const result = controller.waitForResult();
    controller.cancel();

    await expect(result).resolves.toEqual({kind: 'cancelled'});
    expect(controller.getSnapshot().step).toBe('cancelled');
    expect(deps.save).not.toHaveBeenCalled();
  });
});
