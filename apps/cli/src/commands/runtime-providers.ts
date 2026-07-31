import path from 'node:path';

import type {ResolvedConfig} from '@agent-foreman/config';
import {ConfigurationError} from '@agent-foreman/core';
import {
  CodexSupervisorProvider,
  type CodexSupervisorProviderOptions,
} from '@agent-foreman/provider-codex-cli';
import {
  AntigravityCliWorkerProvider,
  GeminiCliWorkerProvider,
} from '@agent-foreman/provider-gemini-cli';

const rawProviderValue = (config: ResolvedConfig, providerId: string, key: string): unknown =>
  config.providers[providerId]?.[key];

const providerString = (
  config: ResolvedConfig,
  providerId: string,
  key: string,
): string | undefined => {
  const value = rawProviderValue(config, providerId, key);
  return typeof value === 'string' ? value : undefined;
};

const providerBoolean = (
  config: ResolvedConfig,
  providerId: string,
  key: string,
): boolean | undefined => {
  const value = rawProviderValue(config, providerId, key);
  return typeof value === 'boolean' ? value : undefined;
};

const providerArgs = (
  config: ResolvedConfig,
  providerId: string,
  key: string,
): readonly string[] | undefined => {
  const value = rawProviderValue(config, providerId, key);
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
};

const codexReasoningEffort = (
  effort: string | undefined,
): CodexSupervisorProviderOptions['reasoningEffort'] => {
  const supported = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
  const selected = supported.find((candidate) => candidate === effort);
  if (effort !== undefined && selected === undefined) {
    throw new ConfigurationError(`Unsupported Codex reasoning effort: ${effort}.`);
  }
  return selected;
};

export const createRuntimeSupervisor = (
  config: ResolvedConfig,
  cacheDirectory: string,
): CodexSupervisorProvider => {
  if (config.supervisor.provider !== 'codex-cli') {
    throw new ConfigurationError(
      `Unsupported runtime supervisor provider: ${config.supervisor.provider}.`,
    );
  }
  const reasoningEffort = codexReasoningEffort(config.supervisor.reasoningEffort);
  return new CodexSupervisorProvider({
    binary: providerString(config, 'codex-cli', 'binary') ?? 'codex',
    ...(config.supervisor.model === undefined ? {} : {model: config.supervisor.model}),
    ...(config.supervisor.sessionMode === undefined
      ? {}
      : {profile: config.supervisor.sessionMode}),
    ...(reasoningEffort === undefined ? {} : {reasoningEffort}),
    cachePath: path.join(cacheDirectory, 'codex-probe.json'),
    ignoreUserConfig: providerBoolean(config, 'codex-cli', 'ignoreUserConfig') ?? true,
  });
};

export const createRuntimeWorker = (
  config: ResolvedConfig,
  cacheDirectory: string,
): GeminiCliWorkerProvider | AntigravityCliWorkerProvider => {
  const providerId = config.worker.provider;
  const binary = providerString(config, providerId, 'binary');
  const sandbox = providerBoolean(config, providerId, 'sandbox');
  const extraArgs = providerArgs(config, providerId, 'extraArgs');
  const argsTemplate = providerArgs(config, providerId, 'argsTemplate');
  const common = {
    ...(binary === undefined ? {} : {binary}),
    ...(config.worker.model === undefined ? {} : {model: config.worker.model}),
    cachePath: path.join(cacheDirectory, `${providerId}-probe.json`),
    ...(sandbox === undefined ? {} : {sandbox}),
    ...(extraArgs === undefined ? {} : {extraArgs}),
    ...(argsTemplate === undefined ? {} : {argsTemplate}),
  };
  if (providerId === 'gemini-cli') return new GeminiCliWorkerProvider(common);
  if (providerId === 'antigravity-cli') return new AntigravityCliWorkerProvider(common);
  throw new ConfigurationError(`Unsupported runtime worker provider: ${providerId}.`);
};
