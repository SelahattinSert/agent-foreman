import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import type {TokenUsage} from '@agent-foreman/contracts';
import {
  ProviderCapabilityError,
  ProviderExecutionError,
  ProviderOutputValidationError,
  ProviderTimeoutError,
  PermissionDeniedError,
  TaskCancelledError,
} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';
import {runProcess} from '@agent-foreman/process';

import type {WorkerCliProbeResult} from './probe.js';

export interface WorkerCliTransportRequest {
  readonly executionId: string;
  readonly prompt: string;
  readonly outputSchema: unknown;
  readonly cwd: string;
  readonly model: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly environmentAllowlist: readonly string[];
  readonly providerSessionId?: string;
}

export interface WorkerCliTransportResponse {
  readonly value: unknown;
  readonly providerSessionId?: string;
  readonly tokenUsage?: TokenUsage;
}

export interface WorkerCliTransport {
  start(): Promise<void>;
  request(input: WorkerCliTransportRequest): Promise<WorkerCliTransportResponse>;
  cancel(executionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface HeadlessWorkerCliTransportOptions {
  readonly binary: string;
  readonly probe: () => Promise<WorkerCliProbeResult>;
  readonly sandbox?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly extraArgs?: readonly string[];
  readonly argsTemplate?: readonly string[];
  readonly isolatedAntigravitySettings?: boolean;
  readonly newProject?: boolean;
  readonly disableSlashCommands?: boolean;
}

const safeEnvironmentNames = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
] as const;

const environmentFor = (
  allowlist: readonly string[],
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv => {
  const names = new Set([...safeEnvironmentNames, ...allowlist]);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = overrides?.[name] ?? process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const unwrapOutput = (raw: unknown): WorkerCliTransportResponse => {
  if (typeof raw !== 'object' || raw === null) return {value: raw};
  const record = raw as Record<string, unknown>;
  const sessionValue = record.conversation_id ?? record.conversationId ?? record.session_id;
  const providerSessionId = typeof sessionValue === 'string' ? sessionValue : undefined;
  const candidate =
    record.structured_output ?? record.response ?? record.result ?? record.output ?? raw;
  let value: unknown = candidate;
  if (typeof candidate === 'string') {
    try {
      value = JSON.parse(candidate) as unknown;
    } catch (cause: unknown) {
      throw new ProviderOutputValidationError('Worker CLI returned a non-JSON structured result.', {
        cause,
      });
    }
  }
  return {value, ...(providerSessionId === undefined ? {} : {providerSessionId})};
};

const antigravitySettings = (cwd: string, sandbox: boolean): Record<string, unknown> => ({
  allowNonWorkspaceAccess: false,
  enableTerminalSandbox: sandbox,
  toolPermission: 'proceed-in-sandbox',
  permissions: {
    allow: [`write_file(${path.resolve(cwd)})`],
    ask: [],
    deny: [
      ...(sandbox ? [] : ['command(*)', 'unsandboxed(*)']),
      'read_url(*)',
      'execute_url(*)',
      'mcp(*)',
      `write_file(${path.join(path.resolve(cwd), '.git')})`,
    ],
  },
});

const isHeadlessPermissionDenial = (stderr: string): boolean =>
  stderr.includes('jetski: no output produced') &&
  stderr.includes('permission') &&
  stderr.includes('headless mode cannot prompt');

const readFailureSummary = async (logPath: string): Promise<string | undefined> => {
  try {
    const lines = (await readFile(logPath, 'utf8')).split('\n');
    const relevant = lines.filter(
      (line) =>
        line.includes('permission check failed') ||
        line.includes('keytool error:') ||
        line.includes('connecting to sandbox server:'),
    );
    const selected = relevant.at(-1)?.trim();
    if (selected === undefined || selected === '') return undefined;
    const redacted = redactValue(selected.slice(0, 2_000));
    return typeof redacted === 'string' ? redacted : undefined;
  } catch {
    return undefined;
  }
};

const renderArgsTemplate = (
  template: readonly string[],
  values: Readonly<Record<string, string>>,
): string[] =>
  template.map((argument) =>
    argument.replace(/\{([a-z_]+)\}/gu, (_match, key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new ProviderCapabilityError(
          `Worker args template uses unknown placeholder {${key}}.`,
        );
      }
      return value;
    }),
  );

export class HeadlessWorkerCliTransport implements WorkerCliTransport {
  private readonly active = new Map<string, AbortController>();

  public constructor(private readonly options: HeadlessWorkerCliTransportOptions) {}

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public async request(input: WorkerCliTransportRequest): Promise<WorkerCliTransportResponse> {
    const capabilities = await this.options.probe();
    if (!capabilities.printMode || !capabilities.jsonOutput || !capabilities.jsonSchema) {
      throw new ProviderCapabilityError(
        'Worker CLI lacks print, JSON output, or JSON schema support required for safe headless execution.',
      );
    }
    if (!capabilities.modelSelection) {
      throw new ProviderCapabilityError('Worker CLI does not expose explicit model selection.');
    }
    if (capabilities.promptFlag === undefined && this.options.argsTemplate === undefined) {
      throw new ProviderCapabilityError('Worker CLI prompt invocation form could not be probed.');
    }
    if (!capabilities.workspaceMode && this.options.argsTemplate === undefined) {
      throw new ProviderCapabilityError(
        'Worker CLI does not expose a probed edit-workspace mode; configure a validated args template.',
      );
    }
    if (input.providerSessionId !== undefined && !capabilities.sessionResume) {
      throw new ProviderCapabilityError(
        'Worker CLI does not support the requested session resume.',
      );
    }
    if (this.options.newProject === true && !capabilities.newProject) {
      throw new ProviderCapabilityError(
        'Worker CLI cannot bind a new provider project to the isolated execution workspace.',
      );
    }
    if (this.options.disableSlashCommands === true && !capabilities.disableSlashCommands) {
      throw new ProviderCapabilityError(
        'Worker CLI cannot disable slash-command expansion for literal structured prompts.',
      );
    }
    const cwd = await realpath(path.resolve(input.cwd));
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worker-'));
    const schemaPath = path.join(temporaryDirectory, 'output-schema.json');
    const logPath = path.join(temporaryDirectory, 'agy.log');
    await writeFile(schemaPath, JSON.stringify(input.outputSchema), {mode: 0o600});
    const environment = environmentFor(input.environmentAllowlist, this.options.environment);
    if (this.options.isolatedAntigravitySettings === true) {
      const isolatedHome = path.join(temporaryDirectory, 'home');
      const settingsDirectory = path.join(isolatedHome, '.gemini', 'antigravity-cli');
      await mkdir(settingsDirectory, {recursive: true, mode: 0o700});
      await writeFile(
        path.join(settingsDirectory, 'settings.json'),
        `${JSON.stringify(antigravitySettings(cwd, this.options.sandbox !== false), null, 2)}\n`,
        {mode: 0o600},
      );
      environment.HOME = isolatedHome;
      environment.USERPROFILE = isolatedHome;
    }
    const controller = new AbortController();
    this.active.set(input.executionId, controller);
    const timeout = `${String(Math.max(1, Math.ceil(input.timeoutMs / 1_000)))}s`;
    const args =
      this.options.argsTemplate === undefined
        ? [
            ...(capabilities.promptFlag === '--prompt'
              ? ['--prompt', input.prompt]
              : ['--print', input.prompt]),
            '--output-format',
            'json',
            '--json-schema',
            schemaPath,
            '--model',
            input.model,
            ...(capabilities.workspaceMode ? ['--mode', 'accept-edits'] : []),
            ...(this.options.sandbox === false || !capabilities.sandbox ? [] : ['--sandbox']),
            ...(capabilities.effort && input.effort !== undefined
              ? ['--effort', input.effort]
              : []),
            ...(input.providerSessionId === undefined
              ? this.options.newProject === true
                ? ['--new-project']
                : []
              : ['--conversation', input.providerSessionId]),
            ...(this.options.disableSlashCommands === true ? ['--disable-slash-commands'] : []),
            ...(capabilities.logFile ? ['--log-file', logPath] : []),
            ...(capabilities.printTimeout ? ['--print-timeout', timeout] : []),
            ...(this.options.extraArgs ?? []),
          ]
        : [
            ...renderArgsTemplate(this.options.argsTemplate, {
              model: input.model,
              prompt: input.prompt,
              schema: schemaPath,
              timeout,
              conversation: input.providerSessionId ?? '',
              effort: input.effort ?? '',
              workspace: cwd,
              log: logPath,
            }),
            ...(input.providerSessionId === undefined && this.options.newProject === true
              ? ['--new-project']
              : []),
            ...(this.options.disableSlashCommands === true ? ['--disable-slash-commands'] : []),
            ...(capabilities.logFile ? ['--log-file', logPath] : []),
            ...(this.options.extraArgs ?? []),
          ];
    try {
      const result = await runProcess({
        executable: this.options.binary,
        args,
        cwd,
        environment,
        inheritEnvironment: false,
        stdio: 'capture',
        signal: AbortSignal.any([input.signal, controller.signal]),
        timeoutMs: input.timeoutMs,
      });
      if (result.timedOut) {
        throw new ProviderTimeoutError('Worker CLI execution timed out.', {
          retryable: true,
          diagnostics: {executionId: input.executionId},
        });
      }
      if (result.aborted) throw new TaskCancelledError('Worker CLI execution was cancelled.');
      if (isHeadlessPermissionDenial(result.stderr)) {
        const detail = await readFailureSummary(logPath);
        throw new PermissionDeniedError(
          `Worker CLI auto-denied a required permission in headless mode.${detail === undefined ? '' : ` ${detail}`}`,
          {
            diagnostics: {
              executionId: input.executionId,
              stderr: redactValue(result.stderr),
            },
          },
        );
      }
      if (result.exitCode !== 0) {
        throw new ProviderExecutionError('Worker CLI execution failed.', {
          diagnostics: {
            executionId: input.executionId,
            exitCode: result.exitCode,
            stderr: redactValue(result.stderr),
          },
        });
      }
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout) as unknown;
      } catch (cause: unknown) {
        throw new ProviderOutputValidationError('Worker CLI emitted malformed JSON.', {cause});
      }
      return unwrapOutput(raw);
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
