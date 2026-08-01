import {randomUUID} from 'node:crypto';
import path from 'node:path';

import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

import {loadResolvedConfig} from '@agent-foreman/config';
import type {QualityGateReport} from '@agent-foreman/contracts';
import {ConfigurationError} from '@agent-foreman/core';
import {SqliteWorkflowStore} from '@agent-foreman/persistence';
import {getAgentForemanPlatformPaths} from '@agent-foreman/process';
import {evaluateDiffPolicyGates, runQualityGates} from '@agent-foreman/quality-gates';
import {
  createAgentForemanMcpServer,
  HeadlessRuntimeService,
  NativeExecutionCoordinator,
} from '@agent-foreman/runtime';
import {
  applyWorkspaceChanges,
  collectWorkspaceDiff,
  prepareGitWorkspace,
  prepareSnapshotWorkspace,
} from '@agent-foreman/workspace';

import {summarizeRepository} from '../workflow/repository-summary.js';
import {
  resolveQualityGateDefinitions,
  resolveWorkspaceExecutionMode,
  runtimeEnvironmentAllowlist,
} from './real-run.js';
import {createRuntimeWorker} from './runtime-providers.js';

const mergeGateReports = (
  command: QualityGateReport,
  policy: QualityGateReport,
): QualityGateReport => ({
  status:
    command.status === 'CANCELLED'
      ? 'CANCELLED'
      : command.status === 'FAILED' || policy.status === 'FAILED'
        ? 'FAILED'
        : 'PASSED',
  failures: [...command.failures, ...policy.failures],
  startedAt: command.startedAt,
  completedAt: policy.completedAt,
  runs: [...(command.runs ?? []), ...(policy.runs ?? [])],
});

export const runMcpServerCommand = async (): Promise<void> => {
  const projectRoot = path.resolve(process.cwd());
  const config = await loadResolvedConfig({projectRoot});
  if (config.worker.model === undefined) {
    throw new ConfigurationError(
      `Global profile ${config.activeProfile} requires an explicit worker model. Run \`af settings\`.`,
    );
  }
  const paths = getAgentForemanPlatformPaths();
  const summary = await summarizeRepository(projectRoot);
  const executionMode = resolveWorkspaceExecutionMode(config.workspace.mode, summary.vcs);
  const gates = await resolveQualityGateDefinitions(config, projectRoot);
  const store = await SqliteWorkflowStore.open({
    databasePath: path.join(paths.stateDirectory, 'state.sqlite3'),
    auditLogPath: path.join(paths.stateDirectory, 'events.jsonl'),
  });
  const worker = createRuntimeWorker(config, path.join(paths.dataDirectory, 'cache'));
  const abortController = new AbortController();
  const execution = new NativeExecutionCoordinator({
    store,
    worker,
    summarizeProject: summarizeRepository,
    prepareWorkspace: async (session, strategy) =>
      executionMode === 'worktree'
        ? await prepareGitWorkspace({
            projectRoot: session.projectRoot,
            taskId: session.id,
            dataDirectory: paths.dataDirectory,
            dirtyStrategy: strategy,
          })
        : await prepareSnapshotWorkspace({
            projectRoot: session.projectRoot,
            taskId: session.id,
            dataDirectory: paths.dataDirectory,
          }),
    collectDiff: async (workspace) => {
      const diff = await collectWorkspaceDiff(workspace);
      return {...diff, changedFiles: [...diff.changedFiles]};
    },
    runQualityGates: async (workspacePath, diff, approvedPlan) => {
      const command = await runQualityGates({
        workspacePath,
        gates,
        signal: abortController.signal,
        environmentAllowlist: runtimeEnvironmentAllowlist,
      });
      const policy = evaluateDiffPolicyGates({
        patch: diff.patch,
        changedFiles: diff.changedFiles,
        allowedAreas: approvedPlan.expectedFileAreas,
      });
      return mergeGateReports(command, policy);
    },
    applyChanges: async (workspace) => {
      const result = await applyWorkspaceChanges({
        workspace,
        sourceProjectRoot: projectRoot,
        approved: true,
      });
      return {
        workspace: result.workspace,
        diff: {...result.diff, changedFiles: [...result.diff.changedFiles]},
      };
    },
    createWorkerContext: (session, workspace) => ({
      sessionId: session.id,
      projectRoot: session.projectRoot,
      executionWorkspace: workspace,
      timeoutMs: 30 * 60 * 1_000,
      abortSignal: abortController.signal,
      permissions: {
        filesystem: 'workspace-write',
        shell: 'project-scoped',
        network: 'ask',
        workerLaunch: 'denied',
      },
      environmentAllowlist: runtimeEnvironmentAllowlist,
      logger: {
        error: (message) => process.stderr.write(`ERROR ${message}\n`),
        warn: (message) => process.stderr.write(`WARN ${message}\n`),
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
      },
      emit: () => undefined,
      providerSessionMetadata: {},
    }),
    loopLimits: config.workflow,
    reviewPolicy: {
      allowOpenMedium: config.quality.allowOpenMedium,
      allowOpenLow: config.quality.allowOpenLow,
    },
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  });
  const service = new HeadlessRuntimeService({
    store,
    workerProvider: config.worker.provider,
    workerModel: config.worker.model,
    allowedProjectRoot: projectRoot,
    execution,
  });
  const server = createAgentForemanMcpServer({service});
  server.server.onclose = () => {
    abortController.abort();
    void worker.dispose();
    store.close();
  };
  server.server.onerror = (error) => {
    process.stderr.write(`Agent Foreman MCP: ${error.message}\n`);
  };
  try {
    await server.connect(new StdioServerTransport());
  } catch (error: unknown) {
    store.close();
    throw error;
  }
};
