import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {
  ProviderExecutionError,
  ProviderOutputValidationError,
  ProviderTimeoutError,
  TaskCancelledError,
} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';
import {runProcess} from '@agent-foreman/process';

import type {CodexTransport, CodexTransportRequest, CodexTransportResponse} from './transport.js';

export interface CodexExecTransportOptions {
  readonly binary: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly ignoreUserConfig?: boolean;
}

const standardEnvironmentNames = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

const selectedEnvironment = (
  names: readonly string[],
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv => {
  const allowed = new Set([...standardEnvironmentNames, ...names]);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = overrides?.[name] ?? process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const parseJsonLines = (raw: string): readonly unknown[] =>
  raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (cause: unknown) {
        throw new ProviderOutputValidationError('Codex emitted malformed JSONL.', {cause});
      }
    });

const metadataFromEvents = (
  events: readonly unknown[],
): Pick<CodexTransportResponse, 'threadId' | 'tokenUsage'> => {
  let threadId: string | undefined;
  let tokenUsage: CodexTransportResponse['tokenUsage'];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record.type === 'thread.started' && typeof record.thread_id === 'string') {
      threadId = record.thread_id;
    }
    if (
      record.type === 'turn.completed' &&
      typeof record.usage === 'object' &&
      record.usage !== null
    ) {
      const usage = record.usage as Record<string, unknown>;
      tokenUsage = {
        ...(typeof usage.input_tokens === 'number' ? {inputTokens: usage.input_tokens} : {}),
        ...(typeof usage.output_tokens === 'number' ? {outputTokens: usage.output_tokens} : {}),
        ...(typeof usage.cached_input_tokens === 'number'
          ? {cachedInputTokens: usage.cached_input_tokens}
          : {}),
      };
    }
  }
  return {
    ...(threadId === undefined ? {} : {threadId}),
    ...(tokenUsage === undefined ? {} : {tokenUsage}),
  };
};

export class CodexExecTransport implements CodexTransport {
  private readonly active = new Map<string, AbortController>();

  public constructor(private readonly options: CodexExecTransportOptions) {}

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public async request(input: CodexTransportRequest): Promise<CodexTransportResponse> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-foreman-codex-'));
    const schemaPath = path.join(temporaryDirectory, 'output-schema.json');
    const outputPath = path.join(temporaryDirectory, 'last-message.json');
    await writeFile(schemaPath, JSON.stringify(input.outputSchema), {mode: 0o600});
    const controller = new AbortController();
    this.active.set(input.executionId, controller);
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const args = [
      'exec',
      '--json',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
      '--sandbox',
      'read-only',
      '--cd',
      input.cwd,
      '--model',
      input.model,
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--color',
      'never',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'project_doc_fallback_filenames=[]',
      ...(this.options.ignoreUserConfig === false ? [] : ['--ignore-user-config']),
      ...(input.profile === undefined ? [] : ['--profile', input.profile]),
      ...(input.reasoningEffort === undefined
        ? []
        : ['-c', `model_reasoning_effort="${input.reasoningEffort}"`]),
      '-',
    ];
    try {
      const result = await runProcess({
        executable: this.options.binary,
        args,
        cwd: input.cwd,
        environment: selectedEnvironment(input.environmentAllowlist, this.options.environment),
        inheritEnvironment: false,
        stdin: input.prompt,
        stdio: 'capture',
        signal,
        timeoutMs: input.timeoutMs,
      });
      if (result.timedOut) {
        throw new ProviderTimeoutError('Codex supervisor execution timed out.', {
          retryable: true,
          diagnostics: {executionId: input.executionId},
        });
      }
      if (result.aborted) throw new TaskCancelledError('Codex supervisor execution was cancelled.');
      if (result.exitCode !== 0) {
        throw new ProviderExecutionError('Codex supervisor execution failed.', {
          diagnostics: {
            executionId: input.executionId,
            exitCode: result.exitCode,
            stderr: redactValue(result.stderr),
          },
        });
      }
      const events = parseJsonLines(result.stdout);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;
      } catch (cause: unknown) {
        throw new ProviderOutputValidationError('Codex final response was not valid JSON.', {
          cause,
          diagnostics: {executionId: input.executionId},
        });
      }
      return {value, events, ...metadataFromEvents(events)};
    } finally {
      this.active.delete(input.executionId);
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
  }

  public cancel(executionId: string): Promise<void> {
    this.active.get(executionId)?.abort('cancelled');
    return Promise.resolve();
  }

  public dispose(): Promise<void> {
    for (const controller of this.active.values()) controller.abort('disposed');
    this.active.clear();
    return Promise.resolve();
  }
}
