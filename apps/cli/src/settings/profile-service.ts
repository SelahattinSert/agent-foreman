import {
  ConfigDocumentSchema,
  loadConfigDocument,
  saveConfigDocument,
  type ConfigDocument,
} from '@agent-foreman/config';
import {ConfigurationError} from '@agent-foreman/core';

export interface SettingsDraft {
  readonly profileName: string;
  readonly supervisorProvider: string;
  readonly supervisorModel: string;
  readonly reasoningEffort?: string;
  readonly workerProvider: string;
  readonly workerModel: string;
}

export interface GlobalProfileServiceOptions {
  readonly configPath: string;
}

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

export const normalizeProfileName = (value: string): string => {
  const name = value.trim();
  if (name.length === 0 || name.length > 64 || !PROFILE_NAME_PATTERN.test(name)) {
    throw new ConfigurationError(
      'Global profile name must start with a letter or number and use at most 64 letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return name;
};

const requiredText = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized === '') {
    throw new ConfigurationError(`${field} is required; Agent Foreman never selects a fallback.`);
  }
  return normalized;
};

export class GlobalProfileService {
  public constructor(private readonly options: GlobalProfileServiceOptions) {}

  public async load(): Promise<ConfigDocument> {
    return (await loadConfigDocument(this.options.configPath)) ?? {version: 1};
  }

  public async candidate(draft: SettingsDraft): Promise<ConfigDocument> {
    const current = await this.load();
    const profileName = normalizeProfileName(draft.profileName);
    const reasoningEffort = draft.reasoningEffort?.trim();
    return ConfigDocumentSchema.parse({
      ...current,
      activeProfile: profileName,
      profiles: {
        ...current.profiles,
        [profileName]: {
          supervisor: {
            provider: requiredText(draft.supervisorProvider, 'Supervisor provider'),
            model: requiredText(draft.supervisorModel, 'Supervisor model'),
            ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : {reasoningEffort}),
          },
          worker: {
            provider: requiredText(draft.workerProvider, 'Worker provider'),
            model: requiredText(draft.workerModel, 'Worker model'),
          },
        },
      },
    });
  }

  public async save(draft: SettingsDraft): Promise<void> {
    await saveConfigDocument(this.options.configPath, await this.candidate(draft));
  }
}
