import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test, vi} from 'vitest';

import {loadConfigDocument, saveConfigDocument} from '@agent-foreman/config';
import type {ModelDescriptor, ProviderDescriptor, ProviderHealth} from '@agent-foreman/contracts';

import {GlobalProfileService, type SettingsDraft} from '../src/settings/profile-service.js';
import {
  discoverSettingsSupervisorModels,
  discoverSettingsWorkerModels,
  validateSettingsDraft,
  type SettingsValidationAdapter,
} from '../src/settings/provider-catalog.js';

const draft = (profileName = 'daily'): SettingsDraft => ({
  profileName,
  supervisorProvider: 'codex-cli',
  supervisorModel: 'supervisor-model',
  reasoningEffort: 'high',
  workerProvider: 'antigravity-cli',
  workerModel: 'worker-model',
});

describe('GlobalProfileService', () => {
  test('stores a native-Codex profile without inventing a supervisor model', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-native-profile-'));
    const configPath = path.join(directory, 'config.toml');
    const service = new GlobalProfileService({configPath});

    await service.save({
      profileName: 'native',
      supervisorProvider: 'codex-cli',
      workerProvider: 'gemini-cli',
      workerModel: 'worker-model',
    });

    await expect(loadConfigDocument(configPath, true)).resolves.toMatchObject({
      activeProfile: 'native',
      profiles: {
        native: {
          supervisor: {provider: 'codex-cli'},
          worker: {provider: 'gemini-cli', model: 'worker-model'},
        },
      },
    });
  });

  test('preserves unrelated global settings and activates the explicitly saved profile', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-profile-service-'));
    const configPath = path.join(directory, 'config.toml');
    await saveConfigDocument(configPath, {
      version: 1,
      general: {telemetry: false, logLevel: 'debug'},
      profiles: {
        existing: {
          supervisor: {provider: 'codex-cli', model: 'old-supervisor'},
          worker: {provider: 'gemini-cli', model: 'old-worker'},
        },
      },
      providers: {'codex-cli': {binary: '/opt/codex'}},
    });

    await new GlobalProfileService({configPath}).save(draft());

    await expect(loadConfigDocument(configPath, true)).resolves.toMatchObject({
      activeProfile: 'daily',
      general: {telemetry: false, logLevel: 'debug'},
      providers: {'codex-cli': {binary: '/opt/codex'}},
      profiles: {
        existing: {worker: {model: 'old-worker'}},
        daily: {
          supervisor: {
            provider: 'codex-cli',
            model: 'supervisor-model',
            reasoningEffort: 'high',
          },
          worker: {provider: 'antigravity-cli', model: 'worker-model'},
        },
      },
    });
  });

  test.each(['', ' ', 'bad/name', 'bad\\name', '.hidden'])(
    'rejects unsafe profile name %j',
    async (name) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'af-profile-name-'));
      const configPath = path.join(directory, 'config.toml');

      await expect(new GlobalProfileService({configPath}).save(draft(name))).rejects.toThrow(
        /profile name/iu,
      );
      await expect(loadConfigDocument(configPath)).resolves.toBeUndefined();
    },
  );

  test('builds a candidate without writing it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-profile-candidate-'));
    const configPath = path.join(directory, 'config.toml');
    const service = new GlobalProfileService({configPath});

    await expect(service.candidate(draft('candidate'))).resolves.toMatchObject({
      activeProfile: 'candidate',
      profiles: {candidate: {worker: {model: 'worker-model'}}},
    });
    await expect(loadConfigDocument(configPath)).resolves.toBeUndefined();
  });
});

const descriptor = (
  id: string,
  role: 'supervisor' | 'worker',
  modelDiscovery: boolean,
): ProviderDescriptor => ({
  id,
  displayName: id,
  transport: 'cli',
  capabilities: {
    supervisorPlanning: role === 'supervisor',
    supervisorReview: role === 'supervisor',
    workerExecution: role === 'worker',
    structuredOutput: true,
    sessionResume: false,
    filesystemTools: true,
    shellTools: true,
    streaming: false,
    tokenUsageReporting: false,
    modelDiscovery,
  },
});

const validationAdapter = (input: {
  readonly descriptor: ProviderDescriptor;
  readonly health: ProviderHealth;
  readonly models?: readonly ModelDescriptor[];
}): SettingsValidationAdapter => {
  const common = {
    descriptor: vi.fn(async () => input.descriptor),
    healthCheck: vi.fn(async () => input.health),
    dispose: vi.fn(async () => undefined),
  };
  const models = input.models;
  return models === undefined
    ? common
    : {...common, discoverModels: vi.fn(async () => [...models])};
};

describe('validateSettingsDraft', () => {
  test('validates only the worker when native Codex owns supervision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-native-validation-'));
    const service = new GlobalProfileService({
      configPath: path.join(directory, 'config.toml'),
    });
    const createSupervisor = vi.fn(() =>
      validationAdapter({
        descriptor: descriptor('codex-cli', 'supervisor', false),
        health: {status: 'FAIL', message: 'Must not run.'},
      }),
    );
    const worker = validationAdapter({
      descriptor: descriptor('gemini-cli', 'worker', true),
      health: {status: 'PASS', message: 'Gemini is ready.'},
      models: [{id: 'worker-model', available: true}],
    });

    const result = await validateSettingsDraft(
      {
        profileName: 'native',
        nativeSupervisor: true,
        supervisorProvider: 'codex-cli',
        workerProvider: 'gemini-cli',
        workerModel: 'worker-model',
      },
      {
        service,
        cacheDirectory: path.join(directory, 'cache'),
        createSupervisor,
        createWorker: () => worker,
      },
    );

    expect(result.status).toBe('PASS');
    expect(result.checks[0]).toMatchObject({role: 'supervisor', status: 'PASS'});
    expect(createSupervisor).not.toHaveBeenCalled();
    expect(worker.healthCheck).toHaveBeenCalledOnce();
  });

  test('validates the unsaved candidate and reports Codex model uncertainty as a warning', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-profile-validation-'));
    const configPath = path.join(directory, 'config.toml');
    const service = new GlobalProfileService({configPath});
    const supervisor = validationAdapter({
      descriptor: descriptor('codex-cli', 'supervisor', false),
      health: {status: 'PASS', message: 'Codex is ready.'},
    });
    const worker = validationAdapter({
      descriptor: descriptor('gemini-cli', 'worker', true),
      health: {status: 'PASS', message: 'Gemini is ready.'},
      models: [{id: 'worker-model', displayName: 'Worker model', available: true}],
    });

    const result = await validateSettingsDraft(draft(), {
      service,
      cacheDirectory: path.join(directory, 'cache'),
      createSupervisor: () => supervisor,
      createWorker: () => worker,
    });

    expect(result.status).toBe('WARN');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({role: 'supervisor', status: 'WARN'}),
        expect.objectContaining({role: 'worker', status: 'PASS'}),
      ]),
    );
    expect(result.workerModels).toEqual([
      {id: 'worker-model', displayName: 'Worker model', available: true},
    ]);
    await expect(loadConfigDocument(configPath)).resolves.toBeUndefined();
    expect(supervisor.dispose).toHaveBeenCalledOnce();
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  test('returns FAIL without writing when a provider rejects the configured model', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-profile-validation-fail-'));
    const configPath = path.join(directory, 'config.toml');
    const service = new GlobalProfileService({configPath});
    const result = await validateSettingsDraft(draft(), {
      service,
      cacheDirectory: path.join(directory, 'cache'),
      createSupervisor: () =>
        validationAdapter({
          descriptor: descriptor('codex-cli', 'supervisor', false),
          health: {status: 'PASS', message: 'Codex is ready.'},
        }),
      createWorker: () =>
        validationAdapter({
          descriptor: descriptor('antigravity-cli', 'worker', true),
          health: {status: 'FAIL', message: 'Configured worker model is unavailable.'},
          models: [],
        }),
    });

    expect(result.status).toBe('FAIL');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'worker',
          status: 'FAIL',
          message: 'Configured worker model is unavailable.',
        }),
      ]),
    );
    await expect(loadConfigDocument(configPath)).resolves.toBeUndefined();
  });

  test('validates the exact configured supervisor model against Codex discovery', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-supervisor-validation-'));
    const service = new GlobalProfileService({configPath: path.join(directory, 'config.toml')});
    const supervisor = validationAdapter({
      descriptor: descriptor('codex-cli', 'supervisor', true),
      health: {status: 'PASS', message: 'Codex is ready.'},
      models: [{id: 'supervisor-model', displayName: 'Supervisor model', available: true}],
    });
    const worker = validationAdapter({
      descriptor: descriptor('gemini-cli', 'worker', true),
      health: {status: 'PASS', message: 'Gemini is ready.'},
      models: [{id: 'worker-model', available: true}],
    });

    const result = await validateSettingsDraft(draft(), {
      service,
      cacheDirectory: path.join(directory, 'cache'),
      createSupervisor: () => supervisor,
      createWorker: () => worker,
    });

    expect(result.status).toBe('PASS');
    expect(result.checks).toEqual([
      {role: 'supervisor', status: 'PASS', message: 'Codex is ready.'},
      {role: 'worker', status: 'PASS', message: 'Gemini is ready.'},
    ]);
    expect(supervisor.discoverModels).toHaveBeenCalledOnce();
  });

  test('discovers supervisor models without persisting the candidate profile', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-supervisor-discovery-'));
    const configPath = path.join(directory, 'config.toml');
    const service = new GlobalProfileService({configPath});
    const supervisor = validationAdapter({
      descriptor: descriptor('codex-cli', 'supervisor', true),
      health: {status: 'PASS', message: 'Health is intentionally not called.'},
      models: [{id: 'gpt-visible', displayName: 'GPT Visible', available: true}],
    });

    const models = await discoverSettingsSupervisorModels(
      'codex-cli',
      {profileName: 'daily', supervisorProvider: 'codex-cli'},
      {
        service,
        cacheDirectory: path.join(directory, 'cache'),
        createSupervisor: () => supervisor,
      },
    );

    expect(models).toEqual([{id: 'gpt-visible', displayName: 'GPT Visible', available: true}]);
    expect(supervisor.healthCheck).not.toHaveBeenCalled();
    expect(supervisor.dispose).toHaveBeenCalledOnce();
    await expect(loadConfigDocument(configPath)).resolves.toBeUndefined();
  });

  test('discovers worker models without health execution or config persistence', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'af-profile-discovery-'));
    const configPath = path.join(directory, 'config.toml');
    const service = new GlobalProfileService({configPath});
    const worker = validationAdapter({
      descriptor: descriptor('gemini-cli', 'worker', true),
      health: {status: 'FAIL', message: 'Health is intentionally not called.'},
      models: [{id: 'gemini-fast', available: true}],
    });

    const models = await discoverSettingsWorkerModels(
      'gemini-cli',
      {
        profileName: 'daily',
        supervisorProvider: 'codex-cli',
        supervisorModel: 'supervisor-model',
        workerProvider: 'gemini-cli',
      },
      {
        service,
        cacheDirectory: path.join(directory, 'cache'),
        createWorker: () => worker,
      },
    );

    expect(models).toEqual([{id: 'gemini-fast', available: true}]);
    expect(worker.healthCheck).not.toHaveBeenCalled();
    expect(worker.dispose).toHaveBeenCalledOnce();
    await expect(loadConfigDocument(configPath)).resolves.toBeUndefined();
  });
});
