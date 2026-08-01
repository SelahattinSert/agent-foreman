import {chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {z} from 'zod';
import {describe, expect, test, vi} from 'vitest';

import type {TaskPlan, WorkerExecutionResult} from '@agent-foreman/contracts';
import {PermissionDeniedError, PlanNotApprovedError} from '@agent-foreman/core';
import type {ProviderExecutionContext} from '@agent-foreman/provider-sdk';

import {
  AntigravityCliWorkerProvider,
  HeadlessWorkerCliTransport,
  probeWorkerCli,
  type WorkerCliProbeResult,
  type WorkerCliTransport,
  type WorkerCliTransportRequest,
  type WorkerCliTransportResponse,
} from '../src/index.js';

const writeWorkerFixture = async (root: string): Promise<string> => {
  const scriptPath = path.join(root, 'agy-fixture.mjs');
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      "const fs = await import('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') fs.writeSync(1, '1.1.8');",
      "else if (args[0] === 'models') fs.writeSync(1, args.includes('--help') ? 'List available models' : 'configured-worker-model\\nother-model\\n');",
      "else if (args.includes('--help')) fs.writeSync(1, '--print --output-format json --json-schema --model --mode accept-edits --sandbox --conversation --effort --print-timeout --new-project --disable-slash-commands --log-file');",
      'else {',
      "  const path = await import('node:path');",
      "  const settingsPath = path.join(process.env.HOME ?? '', '.gemini', 'antigravity-cli', 'settings.json');",
      "  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : undefined;",
      '  fs.writeFileSync(process.env.AF_WORKER_ARGS_FILE, JSON.stringify({args, cwd: process.cwd(), home: process.env.HOME, settings}));',
      '  if (process.env.AF_WORKER_STDERR) fs.writeSync(2, process.env.AF_WORKER_STDERR);',
      "  const logIndex = args.indexOf('--log-file');",
      '  if (logIndex >= 0 && process.env.AF_WORKER_LOG_CONTENT) fs.writeFileSync(args[logIndex + 1], process.env.AF_WORKER_LOG_CONTENT);',
      "  fs.writeSync(1, JSON.stringify({conversation_id: 'conversation-001', response: process.env.AF_WORKER_RESPONSE}));",
      '}',
    ].join('\n'),
    {mode: 0o755},
  );
  await chmod(scriptPath, 0o755);
  if (process.platform !== 'win32') return scriptPath;
  const wrapperPath = path.join(root, 'agy-fixture.cmd');
  await writeFile(
    wrapperPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`,
  );
  return wrapperPath;
};

const probeResult: WorkerCliProbeResult = {
  binary: 'agy',
  version: '1.1.8',
  probedAt: '2026-07-31T10:00:00.000Z',
  printMode: true,
  promptFlag: '--print',
  jsonOutput: true,
  jsonSchema: true,
  modelSelection: true,
  workspaceMode: true,
  sandbox: true,
  sessionResume: true,
  modelDiscovery: true,
  effort: true,
  printTimeout: true,
  newProject: true,
  disableSlashCommands: true,
  logFile: true,
};

const workerResult: WorkerExecutionResult = {
  schemaVersion: 1,
  executionId: 'model-generated-id',
  status: 'COMPLETED',
  summary: 'Implemented the plan.',
  changedFiles: [],
  commandsRun: [],
  testsAdded: [],
  acceptanceCriteriaWorkedOn: [],
  assumptionsMade: [],
  blockers: [],
  knownIssues: [],
};

class StubTransport implements WorkerCliTransport {
  public start(): Promise<void> {
    return Promise.resolve();
  }
  public request(_input: WorkerCliTransportRequest): Promise<WorkerCliTransportResponse> {
    return Promise.resolve({value: workerResult});
  }
  public cancel(_executionId: string): Promise<void> {
    return Promise.resolve();
  }
  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const draftPlan: TaskPlan = {
  schemaVersion: 1,
  taskId: 'task-001',
  version: 1,
  status: 'DRAFT',
  title: 'Worker test',
  objective: 'Exercise the worker boundary.',
  userIntentSummary: 'Test worker safety.',
  assumptions: [],
  requirements: [],
  acceptanceCriteria: [],
  implementationSteps: [],
  expectedFileAreas: [],
  verificationCommands: [],
  risks: [],
  outOfScope: [],
  userDecisions: [],
  createdAt: '2026-07-31T10:00:00.000Z',
};

const context = (workspacePath: string): ProviderExecutionContext => ({
  sessionId: 'task-001',
  projectRoot: '/project',
  executionWorkspace: {
    id: 'task-001',
    path: workspacePath,
    mode: 'worktree',
    status: 'READY',
    createdAt: '2026-07-31T10:00:00.000Z',
  },
  timeoutMs: 10_000,
  abortSignal: new AbortController().signal,
  permissions: {
    filesystem: 'workspace-write',
    shell: 'project-scoped',
    network: 'denied',
    workerLaunch: 'denied',
  },
  environmentAllowlist: [],
  logger: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn()},
  emit: vi.fn(),
  providerSessionMetadata: {},
});

describe('Gemini/Antigravity worker adapter', () => {
  test('probes installed headless capabilities without assuming flags', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-'));
    const binary = await writeWorkerFixture(root);

    await expect(probeWorkerCli({binary})).resolves.toMatchObject({
      version: '1.1.8',
      printMode: true,
      promptFlag: '--print',
      jsonOutput: true,
      jsonSchema: true,
      sessionResume: true,
      newProject: true,
      disableSlashCommands: true,
      logFile: true,
    });
  });

  test('runs in the isolated cwd with structured JSON, explicit model, and safe mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-'));
    const binary = await writeWorkerFixture(root);
    const argsFile = path.join(root, 'args.json');
    const workspace = path.join(root, 'workspace');
    const workspaceAlias = path.join(root, 'workspace-alias');
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const transport = new HeadlessWorkerCliTransport({
      binary,
      probe: async () => probeResult,
      sandbox: true,
      isolatedAntigravitySettings: true,
      newProject: true,
      disableSlashCommands: true,
      environment: {
        AF_WORKER_ARGS_FILE: argsFile,
        AF_WORKER_RESPONSE: JSON.stringify(workerResult),
      },
    });

    const response = await transport.request({
      executionId: 'execution-001',
      prompt: 'worker prompt',
      outputSchema: z.toJSONSchema(z.object({schemaVersion: z.literal(1)})),
      cwd: workspaceAlias,
      model: 'configured-worker-model',
      effort: 'medium',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      environmentAllowlist: ['AF_WORKER_ARGS_FILE', 'AF_WORKER_RESPONSE'],
    });

    expect(response.value).toEqual(workerResult);
    expect(response.providerSessionId).toBe('conversation-001');
    const invocation = JSON.parse(await readFile(argsFile, 'utf8')) as {
      args: string[];
      cwd: string;
      home: string;
      settings: {
        allowNonWorkspaceAccess: boolean;
        enableTerminalSandbox: boolean;
        permissions: {allow: string[]; ask: string[]; deny: string[]};
        toolPermission: string;
      };
    };
    const canonicalWorkspace = await realpath(workspace);
    expect(invocation.cwd).toBe(canonicalWorkspace);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--output-format',
        'json',
        '--json-schema',
        '--model',
        'configured-worker-model',
        '--mode',
        'accept-edits',
        '--sandbox',
        '--new-project',
        '--disable-slash-commands',
      ]),
    );
    expect(invocation.home).toContain('agent-foreman-worker-');
    expect(invocation.settings).toMatchObject({
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: true,
      permissions: {
        ask: [],
      },
      toolPermission: 'proceed-in-sandbox',
    });
    expect(invocation.settings.permissions.allow).toContain(`write_file(${canonicalWorkspace})`);
    expect(invocation.settings.permissions.deny).toContain('read_url(*)');
    expect(invocation.settings.permissions.deny).toContain('execute_url(*)');
    expect(invocation.settings.permissions.deny).toContain('mcp(*)');
    expect(invocation.settings.permissions.deny).toContain(
      `write_file(${path.join(canonicalWorkspace, '.git')})`,
    );
  });

  test('runs Antigravity in worktree-file-tools-only mode when terminal sandbox is disabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-file-only-'));
    const binary = await writeWorkerFixture(root);
    const argsFile = path.join(root, 'file-only-args.json');
    const transport = new HeadlessWorkerCliTransport({
      binary,
      probe: async () => probeResult,
      sandbox: false,
      isolatedAntigravitySettings: true,
      newProject: true,
      disableSlashCommands: true,
      environment: {
        AF_WORKER_ARGS_FILE: argsFile,
        AF_WORKER_RESPONSE: JSON.stringify(workerResult),
      },
    });

    await transport.request({
      executionId: 'file-only-execution',
      prompt: 'edit files only',
      outputSchema: {},
      cwd: root,
      model: 'configured-worker-model',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      environmentAllowlist: ['AF_WORKER_ARGS_FILE', 'AF_WORKER_RESPONSE'],
    });

    const invocation = JSON.parse(await readFile(argsFile, 'utf8')) as {
      args: string[];
      settings: {
        enableTerminalSandbox: boolean;
        permissions: {deny: string[]};
      };
    };
    expect(invocation.args).not.toContain('--sandbox');
    expect(invocation.args).toEqual(
      expect.arrayContaining(['--new-project', '--disable-slash-commands']),
    );
    expect(invocation.settings.enableTerminalSandbox).toBe(false);
    expect(invocation.settings.permissions.deny).toEqual(
      expect.arrayContaining(['command(*)', 'unsandboxed(*)']),
    );
  });

  test('treats Antigravity headless auto-denial as a permission failure even with exit code zero', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-denial-'));
    const binary = await writeWorkerFixture(root);
    const transport = new HeadlessWorkerCliTransport({
      binary,
      probe: async () => probeResult,
      environment: {
        AF_WORKER_ARGS_FILE: path.join(root, 'denial-args.json'),
        AF_WORKER_RESPONSE: '',
        AF_WORKER_STDERR:
          'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
        AF_WORKER_LOG_CONTENT:
          'permission check failed for command "git status": user denied permission to run command',
      },
    });

    let caught: unknown;
    try {
      await transport.request({
        executionId: 'denied-execution',
        prompt: 'worker prompt',
        outputSchema: {},
        cwd: root,
        model: 'configured-worker-model',
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        environmentAllowlist: [
          'AF_WORKER_ARGS_FILE',
          'AF_WORKER_RESPONSE',
          'AF_WORKER_STDERR',
          'AF_WORKER_LOG_CONTENT',
        ],
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    if (!(caught instanceof Error)) throw new Error('Expected a permission error.');
    expect(caught.message).toContain('command "git status"');
  });

  test('uses the probed Gemini --prompt value form without changing prompt arguments', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-prompt-'));
    const binary = await writeWorkerFixture(root);
    const argsFile = path.join(root, 'prompt-args.json');
    const transport = new HeadlessWorkerCliTransport({
      binary,
      probe: async () => ({...probeResult, promptFlag: '--prompt'}),
      environment: {
        AF_WORKER_ARGS_FILE: argsFile,
        AF_WORKER_RESPONSE: JSON.stringify(workerResult),
      },
    });

    await transport.request({
      executionId: 'prompt-execution',
      prompt: 'literal prompt with spaces',
      outputSchema: {},
      cwd: root,
      model: 'configured-worker-model',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      environmentAllowlist: ['AF_WORKER_ARGS_FILE', 'AF_WORKER_RESPONSE'],
    });
    const invocation = JSON.parse(await readFile(argsFile, 'utf8')) as {args: string[]};
    expect(invocation.args.slice(0, 2)).toEqual(['--prompt', 'literal prompt with spaces']);
  });

  test('passes the Antigravity prompt as the value immediately following --print', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-print-'));
    const binary = await writeWorkerFixture(root);
    const argsFile = path.join(root, 'print-args.json');
    const transport = new HeadlessWorkerCliTransport({
      binary,
      probe: async () => probeResult,
      environment: {
        AF_WORKER_ARGS_FILE: argsFile,
        AF_WORKER_RESPONSE: JSON.stringify(workerResult),
      },
    });

    await transport.request({
      executionId: 'print-execution',
      prompt: 'literal Antigravity prompt',
      outputSchema: {},
      cwd: root,
      model: 'configured-worker-model',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      environmentAllowlist: ['AF_WORKER_ARGS_FILE', 'AF_WORKER_RESPONSE'],
    });
    const invocation = JSON.parse(await readFile(argsFile, 'utf8')) as {args: string[]};
    expect(invocation.args.slice(0, 2)).toEqual(['--print', 'literal Antigravity prompt']);
    expect(invocation.args.indexOf('literal Antigravity prompt')).toBeLessThan(
      invocation.args.indexOf('--output-format'),
    );
  });

  test('health-checks the exact configured model without silent fallback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-health-'));
    const binary = await writeWorkerFixture(root);
    const available = new AntigravityCliWorkerProvider({
      binary,
      model: 'configured-worker-model',
    });
    const missing = new AntigravityCliWorkerProvider({binary, model: 'missing-model'});

    await expect(available.healthCheck()).resolves.toMatchObject({status: 'PASS'});
    await expect(available.descriptor()).resolves.toMatchObject({
      capabilities: {filesystemTools: true, shellTools: false, workerExecution: true},
    });
    await expect(missing.healthCheck()).resolves.toMatchObject({
      status: 'FAIL',
      diagnostics: {configuredModel: 'missing-model'},
    });
  });

  test('supports a safe array args template without shell interpolation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-template-'));
    const binary = await writeWorkerFixture(root);
    const argsFile = path.join(root, 'template-args.json');
    const transport = new HeadlessWorkerCliTransport({
      binary,
      probe: async () => probeResult,
      argsTemplate: ['--print', '--model', '{model}', '--json-schema', '{schema}', '{prompt}'],
      environment: {
        AF_WORKER_ARGS_FILE: argsFile,
        AF_WORKER_RESPONSE: JSON.stringify(workerResult),
      },
    });

    await transport.request({
      executionId: 'template-execution',
      prompt: 'literal $(touch never)',
      outputSchema: {},
      cwd: root,
      model: 'configured-worker-model',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      environmentAllowlist: ['AF_WORKER_ARGS_FILE', 'AF_WORKER_RESPONSE'],
    });
    const invocation = JSON.parse(await readFile(argsFile, 'utf8')) as {args: string[]};
    expect(invocation.args).toContain('literal $(touch never)');
    expect(invocation.args).not.toContain('sh');
  });

  test('refuses to call the worker transport for an unapproved plan', async () => {
    const transport = new StubTransport();
    const provider = new AntigravityCliWorkerProvider({
      model: 'configured-worker-model',
      transport,
      probe: async () => probeResult,
    });

    await expect(
      provider.execute(
        {
          approvedPlan: draftPlan,
          approvedPlanHash: 'a'.repeat(64),
          projectSummary: {
            root: '/project',
            vcs: 'git',
            languages: ['TypeScript'],
            packageManagers: ['pnpm'],
            relevantFiles: [],
            summary: 'Fixture project.',
          },
          workspacePath: '/workspace',
          constraints: {
            allowedAreas: [],
            deniedAreas: [],
            networkAccess: 'denied',
            destructiveCommands: 'denied',
          },
          baselineResults: {
            status: 'PASSED',
            failures: [],
            startedAt: '2026-07-31T10:00:00.000Z',
            completedAt: '2026-07-31T10:00:00.000Z',
          },
          outputSchema: {},
        },
        context('/workspace'),
      ),
    ).rejects.toBeInstanceOf(PlanNotApprovedError);
  });
});
