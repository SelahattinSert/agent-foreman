import {resolveConfig, type ResolvedConfig} from '@agent-foreman/config';
import type {ModelDescriptor, ProviderDescriptor, ProviderHealth} from '@agent-foreman/contracts';
import {redactValue} from '@agent-foreman/observability';

import {createRuntimeSupervisor, createRuntimeWorker} from '../commands/runtime-providers.js';
import type {GlobalProfileService, SettingsDraft} from './profile-service.js';

export const SETTINGS_PROVIDER_CATALOG = {
  supervisor: [
    {
      id: 'codex-cli',
      displayName: 'Codex CLI',
      defaultBinary: 'codex',
      reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
  ],
  worker: [
    {id: 'gemini-cli', displayName: 'Gemini CLI', defaultBinary: 'gemini'},
    {id: 'antigravity-cli', displayName: 'Antigravity CLI', defaultBinary: 'agy'},
  ],
} as const;

export interface SettingsValidationAdapter {
  readonly descriptor: () => Promise<ProviderDescriptor>;
  readonly healthCheck: () => Promise<ProviderHealth>;
  readonly discoverModels?: () => Promise<readonly ModelDescriptor[]>;
  readonly dispose?: () => Promise<void>;
}

export interface SettingsValidationCheck {
  readonly role: 'supervisor' | 'worker';
  readonly status: 'PASS' | 'WARN' | 'FAIL';
  readonly message: string;
}

export interface SettingsValidation {
  readonly status: 'PASS' | 'WARN' | 'FAIL';
  readonly checks: readonly SettingsValidationCheck[];
  readonly workerModels: readonly ModelDescriptor[];
}

export interface ValidateSettingsDraftDependencies {
  readonly service: GlobalProfileService;
  readonly cacheDirectory: string;
  readonly createSupervisor?: (
    config: ResolvedConfig,
    cacheDirectory: string,
  ) => SettingsValidationAdapter;
  readonly createWorker?: (
    config: ResolvedConfig,
    cacheDirectory: string,
  ) => SettingsValidationAdapter;
}

export interface DiscoverSettingsWorkerModelsDependencies {
  readonly service: GlobalProfileService;
  readonly cacheDirectory: string;
  readonly createWorker?: (
    config: ResolvedConfig,
    cacheDirectory: string,
  ) => SettingsValidationAdapter;
}

export interface DiscoverSettingsSupervisorModelsDependencies {
  readonly service: GlobalProfileService;
  readonly cacheDirectory: string;
  readonly createSupervisor?: (
    config: ResolvedConfig,
    cacheDirectory: string,
  ) => SettingsValidationAdapter;
}

const overallStatus = (
  checks: readonly SettingsValidationCheck[],
): SettingsValidation['status'] => {
  if (checks.some(({status}) => status === 'FAIL')) return 'FAIL';
  if (checks.some(({status}) => status === 'WARN')) return 'WARN';
  return 'PASS';
};

const normalizedHealthStatus = (
  status: ProviderHealth['status'],
): SettingsValidationCheck['status'] => (status === 'SKIP' ? 'WARN' : status);

const safeErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactValue(raw);
  return typeof redacted === 'string' ? redacted : 'Provider validation failed.';
};

const disposeAdapter = async (adapter: SettingsValidationAdapter | undefined): Promise<void> => {
  if (adapter?.dispose === undefined) return;
  await adapter.dispose().catch(() => undefined);
};

export const validateSettingsDraft = async (
  draft: SettingsDraft,
  dependencies: ValidateSettingsDraftDependencies,
): Promise<SettingsValidation> => {
  const candidate = await dependencies.service.candidate(draft);
  const config = resolveConfig({
    global: candidate,
    cli: {profileName: draft.profileName.trim()},
  });
  if (draft.nativeSupervisor === true) {
    let worker: SettingsValidationAdapter | undefined;
    try {
      worker = (dependencies.createWorker ?? createRuntimeWorker)(
        config,
        dependencies.cacheDirectory,
      );
      const [workerDescriptor, workerHealth] = await Promise.all([
        worker.descriptor(),
        worker.healthCheck(),
      ]);
      let workerModels: readonly ModelDescriptor[] = [];
      let workerCheck: SettingsValidationCheck = {
        role: 'worker',
        status: normalizedHealthStatus(workerHealth.status),
        message: workerHealth.message,
      };
      if (workerDescriptor.capabilities.modelDiscovery) {
        if (worker.discoverModels === undefined) {
          workerCheck = {
            role: 'worker',
            status: 'FAIL',
            message: `${workerDescriptor.displayName} advertised model discovery but did not provide it.`,
          };
        } else {
          workerModels = await worker.discoverModels();
          if (
            workerCheck.status !== 'FAIL' &&
            !workerModels.some(({id, available}) => id === draft.workerModel && available)
          ) {
            workerCheck = {
              role: 'worker',
              status: 'FAIL',
              message: `${workerDescriptor.displayName} did not report configured model ${draft.workerModel} as available; no fallback was selected.`,
            };
          }
        }
      }
      const checks: readonly SettingsValidationCheck[] = [
        {
          role: 'supervisor',
          status: 'PASS',
          message: 'The current native Codex conversation will act as supervisor.',
        },
        workerCheck,
      ];
      return {status: overallStatus(checks), checks, workerModels};
    } catch (error: unknown) {
      const checks: readonly SettingsValidationCheck[] = [
        {
          role: 'supervisor',
          status: 'PASS',
          message: 'The current native Codex conversation will act as supervisor.',
        },
        {role: 'worker', status: 'FAIL', message: safeErrorMessage(error)},
      ];
      return {status: 'FAIL', checks, workerModels: []};
    } finally {
      await disposeAdapter(worker);
    }
  }
  const supervisorModel = draft.supervisorModel?.trim();
  if (supervisorModel === undefined || supervisorModel === '') {
    return {
      status: 'FAIL',
      checks: [
        {
          role: 'supervisor',
          status: 'FAIL',
          message: 'Standalone supervisor validation requires an exact model.',
        },
        {role: 'worker', status: 'FAIL', message: 'Validation did not complete.'},
      ],
      workerModels: [],
    };
  }
  let supervisor: SettingsValidationAdapter | undefined;
  let worker: SettingsValidationAdapter | undefined;
  try {
    supervisor = (dependencies.createSupervisor ?? createRuntimeSupervisor)(
      config,
      dependencies.cacheDirectory,
    );
    worker = (dependencies.createWorker ?? createRuntimeWorker)(
      config,
      dependencies.cacheDirectory,
    );
    const [supervisorDescriptor, workerDescriptor, supervisorHealth, workerHealth] =
      await Promise.all([
        supervisor.descriptor(),
        worker.descriptor(),
        supervisor.healthCheck(),
        worker.healthCheck(),
      ]);

    let workerModels: readonly ModelDescriptor[] = [];
    let workerCheck: SettingsValidationCheck = {
      role: 'worker',
      status: normalizedHealthStatus(workerHealth.status),
      message: workerHealth.message,
    };
    if (workerDescriptor.capabilities.modelDiscovery) {
      if (worker.discoverModels === undefined) {
        workerCheck = {
          role: 'worker',
          status: 'FAIL',
          message: `${workerDescriptor.displayName} advertised model discovery but did not provide it.`,
        };
      } else {
        workerModels = await worker.discoverModels();
        if (
          workerCheck.status !== 'FAIL' &&
          !workerModels.some(({id, available}) => id === draft.workerModel && available)
        ) {
          workerCheck = {
            role: 'worker',
            status: 'FAIL',
            message: `${workerDescriptor.displayName} did not report configured model ${draft.workerModel} as available; no fallback was selected.`,
          };
        }
      }
    }

    const supervisorStatus = normalizedHealthStatus(supervisorHealth.status);
    let supervisorCheck: SettingsValidationCheck;
    if (supervisorDescriptor.capabilities.modelDiscovery) {
      if (supervisor.discoverModels === undefined) {
        supervisorCheck = {
          role: 'supervisor',
          status: 'FAIL',
          message: `${supervisorDescriptor.displayName} advertised model discovery but did not provide it.`,
        };
      } else {
        const supervisorModels = await supervisor.discoverModels();
        supervisorCheck = {
          role: 'supervisor',
          status: supervisorStatus,
          message: supervisorHealth.message,
        };
        if (
          supervisorCheck.status !== 'FAIL' &&
          !supervisorModels.some(({id, available}) => id === supervisorModel && available)
        ) {
          supervisorCheck = {
            role: 'supervisor',
            status: 'FAIL',
            message: `${supervisorDescriptor.displayName} did not report configured model ${supervisorModel} as available; no fallback was selected.`,
          };
        }
      }
    } else {
      supervisorCheck = {
        role: 'supervisor',
        status: supervisorStatus === 'FAIL' ? 'FAIL' : 'WARN',
        message:
          supervisorStatus === 'FAIL'
            ? supervisorHealth.message
            : `${supervisorHealth.message} Exact model ${supervisorModel} cannot be enumerated by this Codex CLI and will not be replaced automatically.`,
      };
    }
    const checks = [supervisorCheck, workerCheck] as const;
    return {status: overallStatus(checks), checks, workerModels};
  } catch (error: unknown) {
    const checks: readonly SettingsValidationCheck[] = [
      {role: 'supervisor', status: 'FAIL', message: safeErrorMessage(error)},
      {role: 'worker', status: 'FAIL', message: 'Validation did not complete.'},
    ];
    return {status: 'FAIL', checks, workerModels: []};
  } finally {
    await Promise.all([disposeAdapter(supervisor), disposeAdapter(worker)]);
  }
};

export const discoverSettingsSupervisorModels = async (
  providerId: string,
  draft: Readonly<Partial<SettingsDraft>>,
  dependencies: DiscoverSettingsSupervisorModelsDependencies,
): Promise<readonly ModelDescriptor[]> => {
  const profileName = draft.profileName?.trim();
  if (profileName === undefined || profileName === '') return [];
  const discoveryDraft: SettingsDraft = {
    profileName,
    supervisorProvider: providerId,
    supervisorModel: draft.supervisorModel ?? '__agent_foreman_model_discovery__',
    ...(draft.reasoningEffort === undefined ? {} : {reasoningEffort: draft.reasoningEffort}),
    workerProvider: draft.workerProvider ?? 'gemini-cli',
    workerModel: draft.workerModel ?? '__agent_foreman_model_discovery__',
  };
  const candidate = await dependencies.service.candidate(discoveryDraft);
  const config = resolveConfig({global: candidate, cli: {profileName}});
  const supervisor = (dependencies.createSupervisor ?? createRuntimeSupervisor)(
    config,
    dependencies.cacheDirectory,
  );
  try {
    const descriptor = await supervisor.descriptor();
    if (!descriptor.capabilities.modelDiscovery || supervisor.discoverModels === undefined)
      return [];
    return (await supervisor.discoverModels()).filter(({available}) => available);
  } finally {
    await disposeAdapter(supervisor);
  }
};

export const discoverSettingsWorkerModels = async (
  providerId: string,
  draft: Readonly<Partial<SettingsDraft>>,
  dependencies: DiscoverSettingsWorkerModelsDependencies,
): Promise<readonly ModelDescriptor[]> => {
  const profileName = draft.profileName?.trim();
  const supervisorProvider = draft.supervisorProvider?.trim();
  const supervisorModel = draft.supervisorModel?.trim();
  if (
    profileName === undefined ||
    profileName === '' ||
    supervisorProvider === undefined ||
    supervisorProvider === ''
  ) {
    return [];
  }
  const discoveryDraft: SettingsDraft = {
    profileName,
    supervisorProvider,
    ...(supervisorModel === undefined || supervisorModel === '' ? {} : {supervisorModel}),
    ...(draft.reasoningEffort === undefined ? {} : {reasoningEffort: draft.reasoningEffort}),
    workerProvider: providerId,
    workerModel: draft.workerModel ?? '__agent_foreman_model_discovery__',
  };
  const candidate = await dependencies.service.candidate(discoveryDraft);
  const config = resolveConfig({global: candidate, cli: {profileName}});
  const worker = (dependencies.createWorker ?? createRuntimeWorker)(
    config,
    dependencies.cacheDirectory,
  );
  try {
    const descriptor = await worker.descriptor();
    if (!descriptor.capabilities.modelDiscovery || worker.discoverModels === undefined) return [];
    return (await worker.discoverModels()).filter(({available}) => available);
  } finally {
    await disposeAdapter(worker);
  }
};
