import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

import {parse} from 'smol-toml';
import {ZodError} from 'zod';

import {ConfigurationError} from '@agent-foreman/core';

import {resolveConfig} from './resolve.js';
import {
  ConfigDocumentSchema,
  type CliConfigOverrides,
  type ConfigDocument,
  type ResolvedConfig,
} from './schema.js';

const camelCaseKey = (key: string): string =>
  key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

const normalizeTomlKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeTomlKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [camelCaseKey(key), normalizeTomlKeys(item)]),
  );
};

export const parseConfigToml = (raw: string, source = '<memory>'): ConfigDocument => {
  try {
    return ConfigDocumentSchema.parse(normalizeTomlKeys(parse(raw)));
  } catch (cause: unknown) {
    const diagnostics =
      cause instanceof ZodError
        ? {
            source,
            issues: cause.issues.map((issue) => ({path: issue.path, message: issue.message})),
          }
        : {source};
    throw new ConfigurationError(`Configuration is invalid: ${source}`, {cause, diagnostics});
  }
};

export const loadConfigDocument = async (
  filePath: string,
  required = false,
): Promise<ConfigDocument | undefined> => {
  try {
    return parseConfigToml(await readFile(filePath, 'utf8'), filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return undefined;
    throw error;
  }
};

export const defaultGlobalConfigPath = (
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  const userDirectory = environment.HOME ?? environment.USERPROFILE ?? homedir();
  if (platform === 'win32') {
    return path.join(
      environment.APPDATA ?? path.join(userDirectory, 'AppData', 'Roaming'),
      'Agent Foreman',
      'config.toml',
    );
  }
  if (platform === 'darwin') {
    return path.join(
      userDirectory,
      'Library',
      'Application Support',
      'Agent Foreman',
      'config.toml',
    );
  }
  return path.join(
    environment.XDG_CONFIG_HOME ?? path.join(userDirectory, '.config'),
    'agent-foreman',
    'config.toml',
  );
};

export interface LoadResolvedConfigInput {
  readonly projectRoot: string;
  readonly globalConfigPath?: string;
  readonly cli?: CliConfigOverrides;
}

export const loadResolvedConfig = async (
  input: LoadResolvedConfigInput,
): Promise<ResolvedConfig> => {
  const globalConfigPath = input.globalConfigPath ?? defaultGlobalConfigPath();
  const projectConfigPath = path.join(input.projectRoot, '.agent-foreman', 'config.toml');
  const [global, project] = await Promise.all([
    loadConfigDocument(globalConfigPath),
    loadConfigDocument(projectConfigPath),
  ]);
  return resolveConfig({
    ...(global === undefined ? {} : {global}),
    ...(project === undefined ? {} : {project}),
    ...(input.cli === undefined ? {} : {cli: input.cli}),
  });
};
