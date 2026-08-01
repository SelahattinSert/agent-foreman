import {chmod, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {z} from 'zod';
import {describe, expect, test, vi} from 'vitest';

import {TaskPlanSchema} from '@agent-foreman/contracts';
import {AgentForemanError, ProviderOutputValidationError} from '@agent-foreman/core';
import type {ProviderExecutionContext} from '@agent-foreman/provider-sdk';

import {
  CodexExecTransport,
  CodexSupervisorProvider,
  createCodexOutputSchema,
  decodeCodexOutput,
  parseCodexModelListPage,
  probeCodexCli,
  type CodexProbeResult,
  type CodexTransport,
  type CodexTransportRequest,
  type CodexTransportResponse,
} from '../src/index.js';

const writeCodexFixture = async (root: string): Promise<string> => {
  const scriptPath = path.join(root, 'codex-fixture.mjs');
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      "const fs = await import('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') fs.writeSync(1, 'codex-cli 99.0.0');",
      "else if (args[0] === 'login') fs.writeSync(1, 'Logged in');",
      "else if (args[0] === 'app-server' && args.includes('--help')) fs.writeSync(1, 'Usage --listen stdio://');",
      "else if (args[0] === 'exec' && args.includes('--help')) fs.writeSync(1, '--json --output-schema --output-last-message --sandbox read-only --cd --model --skip-git-repo-check --ephemeral --ignore-rules --ignore-user-config --color --profile -c --config');",
      "else if (args[0] === 'exec') {",
      '  if (process.env.AF_CODEX_ERROR_EVENT) {',
      "    fs.writeSync(1, process.env.AF_CODEX_ERROR_EVENT + '\\n');",
      '    process.exitCode = 1;',
      '  } else {',
      "  const outputPath = args[args.indexOf('--output-last-message') + 1];",
      "  const prompt = fs.readFileSync(0, 'utf8');",
      '  fs.writeFileSync(process.env.AF_CODEX_ARGS_FILE, JSON.stringify({args, prompt}));',
      '  fs.writeFileSync(outputPath, process.env.AF_CODEX_RESPONSE);',
      '  fs.writeSync(1, \'{"type":"thread.started","thread_id":"thread-001"}\\n\');',
      '  fs.writeSync(1, \'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}\\n\');',
      '  }',
      '}',
    ].join('\n'),
    {mode: 0o755},
  );
  await chmod(scriptPath, 0o755);
  if (process.platform !== 'win32') return scriptPath;
  const wrapperPath = path.join(root, 'codex-fixture.cmd');
  await writeFile(
    wrapperPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`,
  );
  return wrapperPath;
};

const healthyProbe: CodexProbeResult = {
  binary: 'codex',
  version: 'codex-cli 99.0.0',
  probedAt: '2026-07-31T10:00:00.000Z',
  authentication: 'authenticated',
  execJson: true,
  outputSchema: true,
  outputLastMessage: true,
  readOnlySandbox: true,
  workingDirectory: true,
  modelSelection: true,
  skipGitRepositoryCheck: true,
  ephemeral: true,
  ignoreRepositoryRules: true,
  ignoreUserConfig: true,
  colorControl: true,
  profileSelection: true,
  configOverride: true,
  appServer: true,
};

const context = (): ProviderExecutionContext => ({
  sessionId: 'task-001',
  projectRoot: '/project',
  timeoutMs: 10_000,
  abortSignal: new AbortController().signal,
  permissions: {
    filesystem: 'read-only',
    shell: 'read-only-allowlist',
    network: 'denied',
    workerLaunch: 'denied',
  },
  environmentAllowlist: [],
  logger: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn()},
  emit: vi.fn(),
  providerSessionMetadata: {},
});

class StubTransport implements CodexTransport {
  public constructor(private readonly response: unknown) {}
  public start(): Promise<void> {
    return Promise.resolve();
  }
  public request(_input: CodexTransportRequest): Promise<CodexTransportResponse> {
    return Promise.resolve({value: this.response, events: []});
  }
  public cancel(_executionId: string): Promise<void> {
    return Promise.resolve();
  }
  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe('Codex CLI adapter', () => {
  test('converts optional TaskPlan fields to required nullable Codex schema fields', () => {
    const schema = createCodexOutputSchema(TaskPlanSchema) as {
      required: string[];
      properties: {
        approvedAt: {anyOf: unknown[]};
        implementationSteps: {
          items: {required: string[]; properties: {allowedAreas: {anyOf: unknown[]}}};
        };
      };
    };
    const step = schema.properties.implementationSteps.items;

    expect(schema.required).toContain('approvedAt');
    expect(schema.properties.approvedAt.anyOf).toContainEqual({type: 'null'});
    expect(step.required).toContain('allowedAreas');
    expect(step.properties.allowedAreas.anyOf).toContainEqual({type: 'null'});
  });

  test('removes null placeholders only for fields that were optional in the source schema', () => {
    const sourceSchema = z.object({
      name: z.string(),
      optionalLabel: z.string().optional(),
      requiredNullable: z.string().nullable(),
    });

    expect(
      decodeCodexOutput({name: 'demo', optionalLabel: null, requiredNullable: null}, sourceSchema),
    ).toEqual({name: 'demo', requiredNullable: null});
  });

  test('probes only observed Codex CLI surfaces and caches capabilities', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-codex-'));
    const binary = await writeCodexFixture(root);
    const cachePath = path.join(root, 'probe.json');

    const probe = await probeCodexCli({
      binary,
      cachePath,
      now: () => new Date('2026-07-31T10:00:00.000Z'),
    });

    expect(probe).toMatchObject({
      version: 'codex-cli 99.0.0',
      authentication: 'authenticated',
      execJson: true,
      outputSchema: true,
      ignoreRepositoryRules: true,
      ignoreUserConfig: true,
      appServer: true,
    });
    expect(JSON.parse(await readFile(cachePath, 'utf8'))).toMatchObject({binary});
  });

  test('uses read-only exec JSON with schema, explicit model, and prompt on stdin', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-codex-'));
    const binary = await writeCodexFixture(root);
    const argsFile = path.join(root, 'args.json');
    const transport = new CodexExecTransport({
      binary,
      environment: {
        AF_CODEX_ARGS_FILE: argsFile,
        AF_CODEX_RESPONSE: JSON.stringify({ok: true}),
      },
    });

    const response = await transport.request({
      executionId: 'execution-001',
      prompt: 'structured prompt',
      outputSchema: z.toJSONSchema(z.object({ok: z.boolean()})),
      cwd: root,
      model: 'configured-model',
      reasoningEffort: 'high',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      environmentAllowlist: ['AF_CODEX_ARGS_FILE', 'AF_CODEX_RESPONSE'],
    });

    expect(response.value).toEqual({ok: true});
    expect(response.threadId).toBe('thread-001');
    expect(response.tokenUsage).toEqual({inputTokens: 10, outputTokens: 4});
    const invocation = JSON.parse(await readFile(argsFile, 'utf8')) as {
      args: string[];
      prompt: string;
    };
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--json',
        '--output-schema',
        '--sandbox',
        'read-only',
        '--model',
        'configured-model',
        '--ignore-user-config',
      ]),
    );
    expect(invocation.prompt).toBe('structured prompt');
  });

  test('reports redacted Codex JSONL errors emitted on stdout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-codex-error-'));
    const binary = await writeCodexFixture(root);
    const transport = new CodexExecTransport({
      binary,
      environment: {
        AF_CODEX_ERROR_EVENT: JSON.stringify({
          type: 'error',
          message: 'Output schema rejected bearer sk-example-secret-value',
        }),
      },
    });

    const failure: unknown = await transport
      .request({
        executionId: 'execution-error',
        prompt: 'structured prompt',
        outputSchema: z.toJSONSchema(z.object({ok: z.boolean()})),
        cwd: root,
        model: 'configured-model',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        environmentAllowlist: ['AF_CODEX_ERROR_EVENT'],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AgentForemanError);
    if (!(failure instanceof AgentForemanError)) throw new Error('Expected a provider error.');
    expect(failure.code).toBe('AF_PROVIDER_EXECUTION');
    const stdout = failure.diagnostics.stdout;
    expect(typeof stdout).toBe('string');
    if (typeof stdout !== 'string') throw new Error('Expected redacted stdout diagnostics.');
    expect(stdout).toContain('[REDACTED]');
  });

  test('validates supervisor output before returning it to orchestration', async () => {
    const provider = new CodexSupervisorProvider({
      model: 'configured-model',
      transport: new StubTransport({unexpected: true}),
      probe: async () => healthyProbe,
    });

    await expect(
      provider.analyzeRequirements({userRequest: 'Change behavior', conversation: []}, context()),
    ).rejects.toBeInstanceOf(ProviderOutputValidationError);
  });

  test('discovers picker-visible models through the Codex app-server protocol', async () => {
    const page = parseCodexModelListPage({
      data: [
        {
          id: 'model-a',
          displayName: 'Model A',
          description: 'First model',
          hidden: false,
          supportedReasoningEfforts: [{reasoningEffort: 'high'}],
          defaultReasoningEffort: 'high',
          inputModalities: ['text'],
          isDefault: true,
        },
      ],
      nextCursor: null,
    });
    expect(page.models).toEqual([
      {
        id: 'model-a',
        displayName: 'Model A',
        available: true,
        details: {
          description: 'First model',
          isDefault: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['high'],
          inputModalities: ['text'],
        },
      },
    ]);
    const provider = new CodexSupervisorProvider({
      model: 'model-a',
      probe: async () => healthyProbe,
      modelDiscovery: async () => [...page.models],
    });
    await expect(provider.discoverModels()).resolves.toEqual(page.models);
    await expect(provider.descriptor()).resolves.toMatchObject({
      capabilities: {modelDiscovery: true},
    });
    await provider.dispose();
  });
});
