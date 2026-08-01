import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import readline from 'node:readline';

import crossSpawn from 'cross-spawn';
import {z} from 'zod';

import {ModelDescriptorSchema, type ModelDescriptor} from '@agent-foreman/contracts';
import {
  ProviderExecutionError,
  ProviderOutputValidationError,
  ProviderTimeoutError,
} from '@agent-foreman/core';

const ReasoningEffortOptionSchema = z.object({reasoningEffort: z.string().min(1)});
const CodexModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  hidden: z.boolean().default(false),
  supportedReasoningEfforts: z.array(ReasoningEffortOptionSchema).default([]),
  defaultReasoningEffort: z.string().optional(),
  inputModalities: z.array(z.string()).default(['text', 'image']),
  isDefault: z.boolean().default(false),
});
const ModelListResultSchema = z.object({
  data: z.array(CodexModelSchema),
  nextCursor: z.string().nullable(),
});
const RpcResponseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({code: z.number().optional(), message: z.string().min(1)}).optional(),
});

export interface DiscoverCodexModelsOptions {
  readonly binary: string;
  readonly timeoutMs?: number;
}

export interface CodexModelListPage {
  readonly models: readonly ModelDescriptor[];
  readonly nextCursor: string | null;
}

const toDescriptor = (model: z.infer<typeof CodexModelSchema>): ModelDescriptor =>
  ModelDescriptorSchema.parse({
    id: model.id,
    displayName: model.displayName,
    available: !model.hidden,
    details: {
      ...(model.description === undefined ? {} : {description: model.description}),
      isDefault: model.isDefault,
      ...(model.defaultReasoningEffort === undefined
        ? {}
        : {defaultReasoningEffort: model.defaultReasoningEffort}),
      supportedReasoningEfforts: model.supportedReasoningEfforts.map(
        ({reasoningEffort}) => reasoningEffort,
      ),
      inputModalities: model.inputModalities,
    },
  });

export const parseCodexModelListPage = (value: unknown): CodexModelListPage => {
  const page = ModelListResultSchema.parse(value);
  return {models: page.data.map(toDescriptor), nextCursor: page.nextCursor};
};

export const discoverCodexModels = async (
  options: DiscoverCodexModelsOptions,
): Promise<ModelDescriptor[]> =>
  await new Promise<ModelDescriptor[]>((resolve, reject) => {
    const child = crossSpawn(options.binary, ['app-server', '--stdio'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const lines = readline.createInterface({input: child.stdout});
    const models: ModelDescriptor[] = [];
    const seenCursors = new Set<string>();
    let activeRequestId = 1;
    let nextRequestId = 2;
    let completed = false;
    let settled = false;
    let stderr = '';

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(
        new ProviderTimeoutError('Codex model discovery timed out.', {
          retryable: true,
          diagnostics: {binary: options.binary, stderr: stderr.trim()},
        }),
      );
    }, options.timeoutMs ?? 15_000);
    timeout.unref();

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill('SIGTERM');
      reject(error);
    };
    const requestModels = (cursor?: string): void => {
      activeRequestId = nextRequestId++;
      send({
        method: 'model/list',
        id: activeRequestId,
        params: {limit: 100, includeHidden: false, ...(cursor === undefined ? {} : {cursor})},
      });
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    lines.on('line', (line) => {
      if (settled || line.trim() === '') return;
      try {
        const parsed = RpcResponseSchema.safeParse(JSON.parse(line));
        if (!parsed.success || parsed.data.id !== activeRequestId) return;
        if (parsed.data.error !== undefined) {
          fail(
            new ProviderExecutionError(
              `Codex model discovery failed: ${parsed.data.error.message}`,
              {diagnostics: {code: parsed.data.error.code}},
            ),
          );
          return;
        }
        if (activeRequestId === 1) {
          send({method: 'initialized', params: {}});
          requestModels();
          return;
        }
        const page = parseCodexModelListPage(parsed.data.result);
        models.push(...page.models);
        if (page.nextCursor !== null) {
          if (seenCursors.has(page.nextCursor)) {
            fail(
              new ProviderOutputValidationError(
                'Codex model discovery returned a repeated pagination cursor.',
              ),
            );
            return;
          }
          seenCursors.add(page.nextCursor);
          requestModels(page.nextCursor);
          return;
        }
        completed = true;
        child.stdin.end();
      } catch (cause: unknown) {
        fail(
          new ProviderOutputValidationError('Codex returned malformed model discovery output.', {
            cause,
          }),
        );
      }
    });
    child.once('error', (cause: NodeJS.ErrnoException) => {
      fail(
        new ProviderExecutionError(`Failed to start Codex binary: ${options.binary}`, {
          cause,
          diagnostics: {binary: options.binary},
        }),
      );
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      lines.close();
      if (settled) return;
      settled = true;
      if (!completed || exitCode !== 0) {
        reject(
          new ProviderExecutionError('Codex app-server exited before model discovery completed.', {
            diagnostics: {exitCode, stderr: stderr.trim()},
          }),
        );
        return;
      }
      resolve(models);
    });
    child.once('spawn', () => {
      send({
        method: 'initialize',
        id: activeRequestId,
        params: {
          clientInfo: {name: 'agent_foreman', title: 'Agent Foreman', version: '0.1.0'},
          capabilities: null,
        },
      });
    });
  });
