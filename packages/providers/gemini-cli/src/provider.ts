import {randomUUID} from 'node:crypto';
import path from 'node:path';

import {z} from 'zod';

import {
  ModelDescriptorSchema,
  WorkerExecutionResultSchema,
  type ModelDescriptor,
  type ProviderDescriptor,
  type ProviderHealth,
  type WorkerExecutionInput,
  type WorkerExecutionResult,
  type WorkerRevisionInput,
} from '@agent-foreman/contracts';
import {
  ConfigurationError,
  hashTaskPlan,
  PermissionDeniedError,
  PlanHashMismatchError,
  PlanNotApprovedError,
  ProviderExecutionError,
  ProviderOutputValidationError,
} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';
import {runProcess} from '@agent-foreman/process';
import {renderPrompt, type PromptTemplateId} from '@agent-foreman/prompts';
import type {ProviderExecutionContext, WorkerProvider} from '@agent-foreman/provider-sdk';

import {probeWorkerCli, type WorkerCliProbeResult} from './probe.js';
import {
  HeadlessWorkerCliTransport,
  type WorkerCliTransport,
  type WorkerCliTransportResponse,
} from './transport.js';

export interface CliWorkerProviderOptions {
  readonly id: 'gemini-cli' | 'antigravity-cli';
  readonly displayName: string;
  readonly binary?: string;
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly cachePath?: string;
  readonly sandbox?: boolean;
  readonly extraArgs?: readonly string[];
  readonly argsTemplate?: readonly string[];
  readonly isolatedAntigravitySettings?: boolean;
  readonly newProject?: boolean;
  readonly disableSlashCommands?: boolean;
  readonly transport?: WorkerCliTransport;
  readonly probe?: () => Promise<WorkerCliProbeResult>;
}

export class CliWorkerProvider implements WorkerProvider {
  private readonly binary: string;
  private readonly transport: WorkerCliTransport;
  private probePromise: Promise<WorkerCliProbeResult> | undefined;

  public constructor(private readonly options: CliWorkerProviderOptions) {
    this.binary = options.binary ?? (options.id === 'antigravity-cli' ? 'agy' : 'gemini');
    this.transport =
      options.transport ??
      new HeadlessWorkerCliTransport({
        binary: this.binary,
        probe: () => this.probe(),
        ...(options.sandbox === undefined ? {} : {sandbox: options.sandbox}),
        ...(options.extraArgs === undefined ? {} : {extraArgs: options.extraArgs}),
        ...(options.argsTemplate === undefined ? {} : {argsTemplate: options.argsTemplate}),
        ...(options.isolatedAntigravitySettings === undefined
          ? {}
          : {isolatedAntigravitySettings: options.isolatedAntigravitySettings}),
        ...(options.newProject === undefined ? {} : {newProject: options.newProject}),
        ...(options.disableSlashCommands === undefined
          ? {}
          : {disableSlashCommands: options.disableSlashCommands}),
      });
  }

  public async descriptor(): Promise<ProviderDescriptor> {
    const probe = await this.probe();
    return {
      id: this.options.id,
      displayName: this.options.displayName,
      version: probe.version,
      transport: 'cli',
      capabilities: {
        supervisorPlanning: false,
        supervisorReview: false,
        workerExecution:
          probe.printMode &&
          probe.jsonOutput &&
          probe.jsonSchema &&
          (this.options.newProject !== true || probe.newProject) &&
          (this.options.disableSlashCommands !== true || probe.disableSlashCommands) &&
          (probe.workspaceMode || this.options.argsTemplate !== undefined),
        structuredOutput: probe.jsonSchema,
        sessionResume: probe.sessionResume,
        filesystemTools: true,
        shellTools: this.options.sandbox !== false,
        streaming: false,
        tokenUsageReporting: false,
        modelDiscovery: probe.modelDiscovery,
      },
    };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    try {
      const descriptor = await this.descriptor();
      if (!descriptor.capabilities.workerExecution) {
        return {
          status: 'FAIL',
          message: `${this.options.displayName} lacks required headless structured-output capabilities.`,
        };
      }
      if (this.options.model === undefined) {
        return {
          status: 'FAIL',
          message: `${this.options.displayName} worker model is not configured; no silent model fallback is used.`,
        };
      }
      if (descriptor.capabilities.modelDiscovery) {
        const models = await this.discoverModels();
        if (!models.some(({id, available}) => id === this.options.model && available)) {
          return {
            status: 'FAIL',
            message: `${this.options.displayName} did not report configured model ${this.options.model} as available; no fallback was selected.`,
            diagnostics: {configuredModel: this.options.model},
          };
        }
      }
      return {
        status: 'PASS',
        message:
          this.options.sandbox === false
            ? `${this.options.displayName} ${descriptor.version ?? ''} supports headless structured execution in worktree file-tools-only mode; terminal commands are disabled and quality gates run in Agent Foreman.`
            : `${this.options.displayName} ${descriptor.version ?? ''} supports headless structured execution with terminal sandboxing.`,
      };
    } catch (error: unknown) {
      return {
        status: 'FAIL',
        message:
          error instanceof Error ? error.message : `${this.options.displayName} probe failed.`,
      };
    }
  }

  public async discoverModels(): Promise<ModelDescriptor[]> {
    const probe = await this.probe();
    if (!probe.modelDiscovery) return [];
    const result = await runProcess({
      executable: this.binary,
      args: ['models'],
      stdio: 'capture',
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new ProviderExecutionError(`${this.options.displayName} model discovery failed.`, {
        diagnostics: {exitCode: result.exitCode, stderr: redactValue(result.stderr)},
      });
    }
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('Usage'));
    return lines.map((id) => ModelDescriptorSchema.parse({id, displayName: id, available: true}));
  }

  public async execute(
    input: WorkerExecutionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult> {
    this.assertExecutionBoundary(input, context);
    return await this.invoke(
      'worker-initial-execution-v1',
      input.approvedPlan.taskId,
      input.approvedPlanHash,
      input,
      context,
    );
  }

  public async revise(
    input: WorkerRevisionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult> {
    this.assertRevisionBoundary(context);
    const templateId: PromptTemplateId =
      input.openFindings.length === 0 && input.qualityGateFailures.length > 0
        ? 'worker-mechanical-repair-v1'
        : 'worker-revision-v1';
    return await this.invoke(templateId, context.sessionId, input.approvedPlanHash, input, context);
  }

  public async resume(
    providerSessionId: string,
    input: WorkerRevisionInput,
    context: ProviderExecutionContext,
  ): Promise<WorkerExecutionResult> {
    this.assertRevisionBoundary(context);
    return await this.invoke(
      'worker-revision-v1',
      context.sessionId,
      input.approvedPlanHash,
      input,
      context,
      providerSessionId,
    );
  }

  public async cancel(executionId: string): Promise<void> {
    await this.transport.cancel(executionId);
  }

  public async dispose(): Promise<void> {
    await this.transport.dispose();
  }

  private async probe(): Promise<WorkerCliProbeResult> {
    this.probePromise ??=
      this.options.probe?.() ??
      probeWorkerCli({
        binary: this.binary,
        ...(this.options.cachePath === undefined ? {} : {cachePath: this.options.cachePath}),
      });
    return await this.probePromise;
  }

  private assertExecutionBoundary(
    input: WorkerExecutionInput,
    context: ProviderExecutionContext,
  ): void {
    if (input.approvedPlan.status !== 'APPROVED' || input.approvedPlan.approvedAt === undefined) {
      throw new PlanNotApprovedError('Worker execution requires an approved frozen plan.');
    }
    if (hashTaskPlan(input.approvedPlan) !== input.approvedPlanHash) {
      throw new PlanHashMismatchError('Worker input plan does not match its approved hash.');
    }
    if (
      context.executionWorkspace === undefined ||
      path.resolve(context.executionWorkspace.path) !== path.resolve(input.workspacePath)
    ) {
      throw new PermissionDeniedError('Worker input must target the recorded execution workspace.');
    }
    this.assertRevisionBoundary(context);
  }

  private assertRevisionBoundary(context: ProviderExecutionContext): void {
    if (
      context.executionWorkspace === undefined ||
      context.permissions.filesystem !== 'workspace-write' ||
      context.permissions.shell !== 'project-scoped'
    ) {
      throw new PermissionDeniedError(
        'Worker requires workspace-scoped write and shell permissions.',
      );
    }
  }

  private async invoke(
    templateId: PromptTemplateId,
    taskId: string,
    planHash: string,
    payload: unknown,
    context: ProviderExecutionContext,
    providerSessionId?: string,
  ): Promise<WorkerExecutionResult> {
    const model = this.options.model;
    if (model === undefined) {
      throw new ConfigurationError(
        `${this.options.displayName} worker model is not configured; Agent Foreman will not choose another model silently.`,
      );
    }
    const executionId = randomUUID();
    const prompt = renderPrompt({
      templateId,
      taskId,
      planHash,
      expectedSchemaName: 'WorkerExecutionResult@1',
      ...(this.options.sandbox === false
        ? {
            additionalConstraints: [
              'The run_command/terminal tool is disabled for this provider execution; never invoke it.',
              'Inspect the workspace only with built-in directory/search/read file tools, and edit only with built-in write_to_file or replace_file_content tools.',
              'Do not attempt to run tests, builds, Git, package managers, or other shell commands; Agent Foreman runs deterministic quality gates after you return.',
              'Report commandsRun as an empty array and report code changes from the files you actually edited.',
            ],
          }
        : {}),
      payload,
    });
    context.emit({
      type: 'provider.started',
      timestamp: new Date().toISOString(),
      metadata: {executionId, providerId: this.options.id, templateId},
    });
    await this.transport.start();
    let response: WorkerCliTransportResponse;
    try {
      response = await this.transport.request({
        executionId,
        prompt,
        outputSchema: z.toJSONSchema(WorkerExecutionResultSchema),
        cwd: context.executionWorkspace?.path ?? context.projectRoot,
        model,
        ...(this.options.effort === undefined ? {} : {effort: this.options.effort}),
        timeoutMs: context.timeoutMs,
        signal: context.abortSignal,
        environmentAllowlist: context.environmentAllowlist,
        ...(providerSessionId === undefined ? {} : {providerSessionId}),
      });
    } catch (error: unknown) {
      context.emit({
        type: 'provider.failed',
        timestamp: new Date().toISOString(),
        metadata: {executionId, providerId: this.options.id},
      });
      throw error;
    }
    const parsed = WorkerExecutionResultSchema.safeParse(response.value);
    if (!parsed.success) {
      throw new ProviderOutputValidationError(
        `${this.options.displayName} response did not match WorkerExecutionResult.`,
        {
          cause: parsed.error,
          diagnostics: {
            executionId,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
        },
      );
    }
    const normalized = WorkerExecutionResultSchema.parse({
      ...parsed.data,
      executionId,
      ...(response.providerSessionId === undefined
        ? {}
        : {providerSessionId: response.providerSessionId}),
      ...(response.tokenUsage === undefined ? {} : {tokenUsage: response.tokenUsage}),
    });
    context.emit({
      type: 'provider.completed',
      timestamp: new Date().toISOString(),
      metadata: {
        executionId,
        providerId: this.options.id,
        status: normalized.status,
        ...(normalized.providerSessionId === undefined
          ? {}
          : {providerSessionId: normalized.providerSessionId}),
        ...(normalized.tokenUsage === undefined ? {} : {tokenUsage: normalized.tokenUsage}),
      },
    });
    return normalized;
  }
}

export class GeminiCliWorkerProvider extends CliWorkerProvider {
  public constructor(options: Omit<CliWorkerProviderOptions, 'id' | 'displayName'> = {}) {
    super({id: 'gemini-cli', displayName: 'Gemini CLI', ...options});
  }
}

export class AntigravityCliWorkerProvider extends CliWorkerProvider {
  public constructor(options: Omit<CliWorkerProviderOptions, 'id' | 'displayName'> = {}) {
    super({
      id: 'antigravity-cli',
      displayName: 'Antigravity CLI',
      ...options,
      sandbox: options.sandbox ?? false,
      isolatedAntigravitySettings: true,
      newProject: true,
      disableSlashCommands: true,
    });
  }
}
