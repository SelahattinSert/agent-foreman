import {randomUUID} from 'node:crypto';

import {z} from 'zod';

import {
  RequirementDiscoveryResultSchema,
  ReviewDecisionSchema,
  TaskPlanSchema,
  type FinalReviewDecision,
  type ProviderDescriptor,
  type ProviderHealth,
  type RequirementDiscoveryResult,
  type ReviewDecision,
  type TaskPlan,
} from '@agent-foreman/contracts';
import {
  ConfigurationError,
  ProviderCapabilityError,
  ProviderOutputValidationError,
} from '@agent-foreman/core';
import {renderPrompt, type PromptTemplateId} from '@agent-foreman/prompts';
import type {
  DraftPlanInput,
  FinalReviewInput,
  ProviderExecutionContext,
  RequirementDiscoveryInput,
  ReviewInput,
  RevisePlanInput,
  SupervisorProvider,
} from '@agent-foreman/provider-sdk';

import {CodexExecTransport} from './exec-transport.js';
import {probeCodexCli, type CodexProbeResult} from './probe.js';
import type {CodexTransport, CodexTransportResponse} from './transport.js';

export interface CodexSupervisorProviderOptions {
  readonly binary?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly cachePath?: string;
  readonly transport?: CodexTransport;
  readonly ignoreUserConfig?: boolean;
  readonly probe?: () => Promise<CodexProbeResult>;
}

export class CodexSupervisorProvider implements SupervisorProvider {
  private readonly binary: string;
  private readonly transport: CodexTransport;
  private probePromise: Promise<CodexProbeResult> | undefined;

  public constructor(private readonly options: CodexSupervisorProviderOptions = {}) {
    this.binary = options.binary ?? 'codex';
    this.transport =
      options.transport ??
      new CodexExecTransport({
        binary: this.binary,
        ...(options.ignoreUserConfig === undefined
          ? {}
          : {ignoreUserConfig: options.ignoreUserConfig}),
      });
  }

  public async descriptor(): Promise<ProviderDescriptor> {
    const probe = await this.probe();
    const safeExec = this.supportsSafeExec(probe);
    return {
      id: 'codex-cli',
      displayName: 'Codex CLI',
      version: probe.version,
      transport: 'cli',
      capabilities: {
        supervisorPlanning: safeExec,
        supervisorReview: safeExec,
        workerExecution: false,
        structuredOutput: safeExec,
        sessionResume: false,
        filesystemTools: true,
        shellTools: true,
        streaming: probe.execJson,
        tokenUsageReporting: probe.execJson,
        modelDiscovery: false,
      },
    };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    try {
      const probe = await this.probe();
      if (!this.supportsSafeExec(probe)) {
        return {
          status: 'FAIL',
          message:
            'Codex CLI lacks one or more probed safe structured-exec flags Agent Foreman requires.',
          diagnostics: {version: probe.version},
        };
      }
      if (this.options.ignoreUserConfig !== false && !probe.ignoreUserConfig) {
        return {
          status: 'FAIL',
          message:
            'Codex CLI lacks --ignore-user-config required by the configured supervisor isolation.',
          diagnostics: {version: probe.version},
        };
      }
      if (this.options.profile !== undefined && !probe.profileSelection) {
        return {
          status: 'FAIL',
          message: 'Codex CLI lacks --profile required by the configured supervisor profile.',
          diagnostics: {version: probe.version},
        };
      }
      if (this.options.reasoningEffort !== undefined && !probe.configOverride) {
        return {
          status: 'FAIL',
          message: 'Codex CLI lacks the config override needed for reasoning effort.',
          diagnostics: {version: probe.version},
        };
      }
      if (probe.authentication !== 'authenticated') {
        return {
          status: probe.authentication === 'missing' ? 'FAIL' : 'WARN',
          message: 'Codex CLI authentication could not be confirmed.',
          diagnostics: {authentication: probe.authentication, version: probe.version},
        };
      }
      if (this.options.model === undefined) {
        return {
          status: 'FAIL',
          message:
            'The active Agent Foreman profile must name a Codex supervisor model; no silent model fallback is used.',
          diagnostics: {version: probe.version},
        };
      }
      return {
        status: 'PASS',
        message: `Codex CLI ${probe.version} is authenticated and supports structured exec.`,
      };
    } catch (error: unknown) {
      return {
        status: 'FAIL',
        message: error instanceof Error ? error.message : 'Codex CLI probe failed.',
      };
    }
  }

  public async analyzeRequirements(
    input: RequirementDiscoveryInput,
    context: ProviderExecutionContext,
  ): Promise<RequirementDiscoveryResult> {
    return await this.invoke(
      'supervisor-requirement-discovery-v1',
      context.sessionId,
      undefined,
      'RequirementDiscoveryResult@1',
      input,
      RequirementDiscoveryResultSchema,
      context,
    );
  }

  public async draftPlan(
    input: DraftPlanInput,
    context: ProviderExecutionContext,
  ): Promise<TaskPlan> {
    const plan = await this.invoke(
      'supervisor-draft-plan-v1',
      input.taskId,
      undefined,
      'TaskPlan@1',
      input,
      TaskPlanSchema,
      context,
    );
    if (
      plan.taskId !== input.taskId ||
      plan.version !== input.version ||
      plan.status !== 'DRAFT' ||
      plan.createdAt !== input.createdAt
    ) {
      throw new ProviderOutputValidationError(
        'Codex draft plan identity does not match its request.',
      );
    }
    return plan;
  }

  public async revisePlan(
    input: RevisePlanInput,
    context: ProviderExecutionContext,
  ): Promise<TaskPlan> {
    const plan = await this.invoke(
      'supervisor-revise-plan-v1',
      input.currentPlan.taskId,
      undefined,
      'TaskPlan@1',
      input,
      TaskPlanSchema,
      context,
    );
    if (
      plan.taskId !== input.currentPlan.taskId ||
      plan.version !== input.version ||
      plan.status !== 'DRAFT' ||
      plan.createdAt !== input.createdAt
    ) {
      throw new ProviderOutputValidationError(
        'Codex revised plan identity does not match its request.',
      );
    }
    return plan;
  }

  public async reviewImplementation(
    input: ReviewInput,
    context: ProviderExecutionContext,
  ): Promise<ReviewDecision> {
    return await this.invoke(
      'supervisor-review-v1',
      input.approvedPlan.taskId,
      input.approvedPlanHash,
      'ReviewDecision@1',
      input,
      ReviewDecisionSchema,
      context,
    );
  }

  public async finalReview(
    input: FinalReviewInput,
    context: ProviderExecutionContext,
  ): Promise<FinalReviewDecision> {
    return await this.invoke(
      'supervisor-final-review-v1',
      input.approvedPlan.taskId,
      input.approvedPlanHash,
      'FinalReviewDecision@1',
      input,
      ReviewDecisionSchema,
      context,
    );
  }

  public async dispose(): Promise<void> {
    await this.transport.dispose();
  }

  private async probe(): Promise<CodexProbeResult> {
    this.probePromise ??=
      this.options.probe?.() ??
      probeCodexCli({
        binary: this.binary,
        ...(this.options.cachePath === undefined ? {} : {cachePath: this.options.cachePath}),
      });
    return await this.probePromise;
  }

  private supportsSafeExec(probe: CodexProbeResult): boolean {
    return (
      probe.execJson &&
      probe.outputSchema &&
      probe.outputLastMessage &&
      probe.readOnlySandbox &&
      probe.workingDirectory &&
      probe.modelSelection &&
      probe.skipGitRepositoryCheck &&
      probe.ephemeral &&
      probe.ignoreRepositoryRules &&
      probe.colorControl &&
      probe.configOverride
    );
  }

  private async invoke<T>(
    templateId: PromptTemplateId,
    taskId: string,
    planHash: string | undefined,
    expectedSchemaName: string,
    payload: unknown,
    schema: z.ZodType<T>,
    context: ProviderExecutionContext,
  ): Promise<T> {
    const model = this.options.model;
    if (model === undefined) {
      throw new ConfigurationError(
        'Codex supervisor model is not configured; Agent Foreman will not choose another model silently.',
      );
    }
    const descriptor = await this.descriptor();
    if (!descriptor.capabilities.structuredOutput) {
      throw new ProviderCapabilityError('Codex CLI structured output is unavailable.');
    }
    const executionId = randomUUID();
    const prompt = renderPrompt({
      templateId,
      taskId,
      ...(planHash === undefined ? {} : {planHash}),
      expectedSchemaName,
      payload,
    });
    context.emit({
      type: 'provider.started',
      timestamp: new Date().toISOString(),
      metadata: {executionId, providerId: 'codex-cli', templateId},
    });
    await this.transport.start();
    let response: CodexTransportResponse;
    try {
      response = await this.transport.request({
        executionId,
        prompt,
        outputSchema: z.toJSONSchema(schema),
        cwd: context.projectRoot,
        model,
        ...(this.options.profile === undefined ? {} : {profile: this.options.profile}),
        ...(this.options.reasoningEffort === undefined
          ? {}
          : {reasoningEffort: this.options.reasoningEffort}),
        timeoutMs: context.timeoutMs,
        signal: context.abortSignal,
        environmentAllowlist: context.environmentAllowlist,
      });
    } catch (error: unknown) {
      context.emit({
        type: 'provider.failed',
        timestamp: new Date().toISOString(),
        metadata: {executionId, providerId: 'codex-cli'},
      });
      throw error;
    }
    const parsed = schema.safeParse(response.value);
    if (!parsed.success) {
      throw new ProviderOutputValidationError('Codex response did not match the required schema.', {
        cause: parsed.error,
        diagnostics: {
          executionId,
          issues: parsed.error.issues.map((issue) => ({path: issue.path, message: issue.message})),
        },
      });
    }
    context.emit({
      type: 'provider.completed',
      timestamp: new Date().toISOString(),
      metadata: {
        executionId,
        providerId: 'codex-cli',
        ...(response.threadId === undefined ? {} : {providerSessionId: response.threadId}),
        ...(response.tokenUsage === undefined ? {} : {tokenUsage: response.tokenUsage}),
      },
    });
    return parsed.data;
  }
}
