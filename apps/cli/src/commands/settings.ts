import path from 'node:path';

import {
  defaultGlobalConfigPath,
  loadResolvedConfig,
  type CliConfigOverrides,
  type ResolvedConfig,
} from '@agent-foreman/config';
import {ConfigurationError} from '@agent-foreman/core';
import {getAgentForemanPlatformPaths} from '@agent-foreman/process';

import {
  discoverSettingsSupervisorModels,
  discoverSettingsWorkerModels,
  validateSettingsDraft,
} from '../settings/provider-catalog.js';
import {GlobalProfileService} from '../settings/profile-service.js';
import {SettingsController, type SettingsWizardResult} from '../settings/settings-controller.js';
import {runSettingsTui} from '../tui/settings-tui.js';
import {settingsCommand as showResolvedSettings} from './configuration.js';

export interface RunSettingsCommandOptions {
  readonly interactive: boolean;
  readonly projectRoot: string;
  readonly noColor: boolean;
  readonly initialProfile?: string;
}

export interface RunSettingsCommandDependencies {
  readonly runTui: (options: RunSettingsCommandOptions) => Promise<SettingsWizardResult>;
  readonly showReadonly: (projectRoot: string, write: (message: string) => void) => Promise<void>;
}

const runGlobalSettingsTui = async (
  options: RunSettingsCommandOptions,
): Promise<SettingsWizardResult> => {
  const configPath = defaultGlobalConfigPath();
  const service = new GlobalProfileService({configPath});
  const paths = getAgentForemanPlatformPaths();
  const cacheDirectory = path.join(paths.dataDirectory, 'cache');
  const controller = new SettingsController({
    service,
    nativeSupervisor: true,
    ...(options.initialProfile === undefined ? {} : {initialProfile: options.initialProfile}),
    validate: async (draft) => await validateSettingsDraft(draft, {service, cacheDirectory}),
    discoverSupervisorModels: async (providerId, draft) =>
      await discoverSettingsSupervisorModels(providerId, draft, {service, cacheDirectory}),
    discoverWorkerModels: async (providerId, draft) =>
      await discoverSettingsWorkerModels(providerId, draft, {service, cacheDirectory}),
  });
  return await runSettingsTui({
    controller,
    noColor: options.noColor,
    screenReader: process.env.INK_SCREEN_READER === 'true',
    configPath,
  });
};

const defaultDependencies: RunSettingsCommandDependencies = {
  runTui: runGlobalSettingsTui,
  showReadonly: async (projectRoot, write) => {
    await showResolvedSettings(write, projectRoot);
  },
};

export const runSettingsCommand = async (
  options: RunSettingsCommandOptions,
  write: (message: string) => void,
  dependencies: RunSettingsCommandDependencies = defaultDependencies,
): Promise<SettingsWizardResult | undefined> => {
  if (!options.interactive) {
    await dependencies.showReadonly(options.projectRoot, write);
    return undefined;
  }
  return await dependencies.runTui(options);
};

export interface EnsureConfiguredProfileInput {
  readonly projectRoot: string;
  readonly cli: CliConfigOverrides;
  readonly interactive: boolean;
  readonly output: string;
  readonly noColor: boolean;
}

export interface EnsureConfiguredProfileDependencies {
  readonly load?: typeof loadResolvedConfig;
  readonly setup?: (options: RunSettingsCommandOptions) => Promise<SettingsWizardResult>;
}

export const ensureConfiguredProfile = async (
  input: EnsureConfiguredProfileInput,
  dependencies: EnsureConfiguredProfileDependencies = {},
): Promise<ResolvedConfig> => {
  const load = dependencies.load ?? loadResolvedConfig;
  const setup = dependencies.setup ?? runGlobalSettingsTui;
  const first = await load({projectRoot: input.projectRoot, cli: input.cli});
  if (first.supervisor.model !== undefined && first.worker.model !== undefined) return first;
  if (!input.interactive || input.output === 'json') {
    throw new ConfigurationError(
      'The selected profile requires explicit supervisor and worker models. Run `af settings` in an interactive terminal.',
    );
  }
  const result = await setup({
    interactive: true,
    projectRoot: input.projectRoot,
    noColor: input.noColor,
    initialProfile: first.activeProfile,
  });
  if (result.kind === 'cancelled') {
    throw new ConfigurationError('Global profile setup was cancelled before the task started.');
  }
  const reloaded = await load({
    projectRoot: input.projectRoot,
    cli: {...input.cli, profileName: result.profileName},
  });
  if (reloaded.supervisor.model === undefined || reloaded.worker.model === undefined) {
    throw new ConfigurationError(
      `Global profile ${result.profileName} is incomplete under the current configuration precedence.`,
    );
  }
  return reloaded;
};
