import path from 'node:path';

import {
  defaultGlobalConfigPath,
  loadConfigDocument,
  loadResolvedConfig,
  saveConfigDocument,
  type ConfigDocument,
  type Profile,
} from '@agent-foreman/config';
import {ConfigurationError} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';

export interface ProfileMutationOptions {
  readonly supervisor?: string;
  readonly supervisorModel?: string;
  readonly reasoningEffort?: string;
  readonly worker?: string;
  readonly workerModel?: string;
}

const globalDocument = async (): Promise<{path: string; document: ConfigDocument}> => {
  const configPath = defaultGlobalConfigPath();
  return {
    path: configPath,
    document: (await loadConfigDocument(configPath)) ?? {version: 1},
  };
};

const profileFrom = (options: ProfileMutationOptions, existing?: Profile): Profile => {
  const supervisorProvider = options.supervisor ?? existing?.supervisor.provider ?? 'codex-cli';
  const workerProvider = options.worker ?? existing?.worker.provider ?? 'gemini-cli';
  const supervisorModel = options.supervisorModel ?? existing?.supervisor.model;
  const workerModel = options.workerModel ?? existing?.worker.model;
  if (supervisorModel === undefined || workerModel === undefined) {
    throw new ConfigurationError(
      'Both --supervisor-model and --worker-model are required; model fallback is never silent.',
    );
  }
  return {
    supervisor: {
      provider: supervisorProvider,
      model: supervisorModel,
      ...(options.reasoningEffort === undefined
        ? existing?.supervisor.reasoningEffort === undefined
          ? {}
          : {reasoningEffort: existing.supervisor.reasoningEffort}
        : {reasoningEffort: options.reasoningEffort}),
    },
    worker: {provider: workerProvider, model: workerModel},
  };
};

export const listProfilesCommand = async (write: (message: string) => void): Promise<void> => {
  const {document} = await globalDocument();
  const active = document.activeProfile;
  const names = Object.keys(document.profiles ?? {}).sort();
  if (names.length === 0) {
    write(
      'No user profiles. The safe built-in `balanced` profile requires explicit model flags.\n',
    );
    return;
  }
  for (const name of names) write(`${name === active ? '*' : ' '} ${name}\n`);
};

export const createProfileCommand = async (
  name: string,
  options: ProfileMutationOptions,
  write: (message: string) => void,
): Promise<void> => {
  const current = await globalDocument();
  if (current.document.profiles?.[name] !== undefined) {
    throw new ConfigurationError(`Profile ${name} already exists.`);
  }
  const profile = profileFrom(options);
  await saveConfigDocument(current.path, {
    ...current.document,
    activeProfile: current.document.activeProfile ?? name,
    profiles: {...current.document.profiles, [name]: profile},
  });
  write(`Created profile ${name} in ${current.path}.\n`);
};

export const editProfileCommand = async (
  name: string,
  options: ProfileMutationOptions,
  write: (message: string) => void,
): Promise<void> => {
  const current = await globalDocument();
  const existing = current.document.profiles?.[name];
  if (existing === undefined) throw new ConfigurationError(`Profile ${name} does not exist.`);
  await saveConfigDocument(current.path, {
    ...current.document,
    profiles: {...current.document.profiles, [name]: profileFrom(options, existing)},
  });
  write(`Updated profile ${name}.\n`);
};

export const useProfileCommand = async (
  name: string,
  write: (message: string) => void,
): Promise<void> => {
  const current = await globalDocument();
  if (name !== 'balanced' && current.document.profiles?.[name] === undefined) {
    throw new ConfigurationError(`Profile ${name} does not exist.`);
  }
  await saveConfigDocument(current.path, {...current.document, activeProfile: name});
  write(`Active profile: ${name}.\n`);
};

export const deleteProfileCommand = async (
  name: string,
  write: (message: string) => void,
): Promise<void> => {
  const current = await globalDocument();
  if (current.document.activeProfile === name) {
    throw new ConfigurationError('Select another active profile before deleting this one.');
  }
  if (current.document.profiles?.[name] === undefined) {
    write(`Profile ${name} does not exist.\n`);
    return;
  }
  const profiles = Object.fromEntries(
    Object.entries(current.document.profiles).filter(([profileName]) => profileName !== name),
  );
  await saveConfigDocument(current.path, {...current.document, profiles});
  write(`Deleted profile ${name}.\n`);
};

export const initProjectCommand = async (
  options: ProfileMutationOptions & {readonly profile?: string},
  write: (message: string) => void,
): Promise<void> => {
  const profileName = options.profile ?? 'balanced';
  const profile = profileFrom(options);
  const configPath = path.join(process.cwd(), '.agent-foreman', 'config.toml');
  const existing = (await loadConfigDocument(configPath)) ?? {version: 1};
  await saveConfigDocument(configPath, {
    ...existing,
    activeProfile: profileName,
    profiles: {...existing.profiles, [profileName]: profile},
  });
  write(`Initialized ${configPath}.\n`);
};

export const settingsCommand = async (write: (message: string) => void): Promise<void> => {
  const config = await loadResolvedConfig({projectRoot: process.cwd()});
  write(`${JSON.stringify(redactValue(config), null, 2)}\n`);
};
