import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';

import {loadResolvedConfig} from '@agent-foreman/config';
import type {WorkflowEventRecord} from '@agent-foreman/contracts';
import {ConfigurationError, transitionWorkflow} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';
import {SqliteWorkflowStore} from '@agent-foreman/persistence';
import {getAgentForemanPlatformPaths} from '@agent-foreman/process';
import type {ProviderExecutionContext} from '@agent-foreman/provider-sdk';
import {runQualityGates} from '@agent-foreman/quality-gates';
import {
  applyWorkspaceChanges,
  collectWorkspaceDiff,
  discardGitWorkspace,
  discardSnapshotWorkspace,
  prepareGitWorkspace,
  prepareSnapshotWorkspace,
} from '@agent-foreman/workspace';

import {PlainWorkflowInteraction} from '../workflow/plain-interaction.js';
import {summarizeRepository} from '../workflow/repository-summary.js';
import {resumeApplyWorkflow} from '../workflow/resume-apply-workflow.js';
import {resumeExecutionWorkflow} from '../workflow/resume-execution-workflow.js';
import {resumePlanningWorkflow} from '../workflow/resume-planning-workflow.js';
import {
  createRuntimeSupervisor,
  createRuntimeWorker,
  resolveQualityGateDefinitions,
  resolveWorkspaceExecutionMode,
  runtimeEnvironmentAllowlist,
} from './real-run.js';

const openStore = async (): Promise<SqliteWorkflowStore> => {
  const paths = getAgentForemanPlatformPaths();
  return await SqliteWorkflowStore.open({
    databasePath: path.join(paths.stateDirectory, 'state.sqlite3'),
    auditLogPath: path.join(paths.stateDirectory, 'events.jsonl'),
  });
};

export const taskListCommand = async (write: (message: string) => void): Promise<void> => {
  const store = await openStore();
  try {
    const sessions = await store.listSessions();
    if (sessions.length === 0) {
      write('No persisted tasks.\n');
      return;
    }
    for (const session of sessions) {
      write(
        `${session.id}  ${session.state.padEnd(24)}  ${session.updatedAt}  ${session.projectRoot}\n`,
      );
    }
  } finally {
    store.close();
  }
};

export const taskShowCommand = async (
  sessionId: string,
  write: (message: string) => void,
): Promise<void> => {
  const store = await openStore();
  try {
    const snapshot = await store.loadResumeSnapshot(sessionId);
    if (snapshot === undefined) throw new ConfigurationError(`Task ${sessionId} was not found.`);
    write(`${JSON.stringify(redactValue(snapshot), null, 2)}\n`);
  } finally {
    store.close();
  }
};

export const taskLogsCommand = async (
  sessionId: string,
  write: (message: string) => void,
): Promise<void> => {
  const store = await openStore();
  try {
    if ((await store.getSession(sessionId)) === undefined) {
      throw new ConfigurationError(`Task ${sessionId} was not found.`);
    }
    for (const event of await store.listEvents(sessionId)) {
      write(`${JSON.stringify(redactValue(event))}\n`);
    }
  } finally {
    store.close();
  }
};

export const taskDiffCommand = async (
  sessionId: string,
  write: (message: string) => void,
): Promise<void> => {
  const store = await openStore();
  try {
    const snapshot = await store.loadResumeSnapshot(sessionId);
    if (snapshot === undefined) throw new ConfigurationError(`Task ${sessionId} was not found.`);
    if (snapshot.workspace === undefined) {
      throw new ConfigurationError(`Task ${sessionId} has no execution workspace.`);
    }
    const diff = await collectWorkspaceDiff(snapshot.workspace);
    write(diff.patch === '' ? 'No changes.\n' : `${diff.patch}\n`);
  } finally {
    store.close();
  }
};

export const taskCancelCommand = async (
  sessionId: string,
  write: (message: string) => void,
): Promise<void> => {
  const store = await openStore();
  try {
    const session = await store.getSession(sessionId);
    if (session === undefined) throw new ConfigurationError(`Task ${sessionId} was not found.`);
    if (session.state === 'CANCELLED') {
      write(`Task ${sessionId} is already cancelled.\n`);
      return;
    }
    if (session.state === 'COMPLETED' || session.state === 'FAILED') {
      throw new ConfigurationError(`Task ${sessionId} is terminal (${session.state}).`);
    }
    const timestamp = new Date().toISOString();
    const event = {type: 'TASK_CANCELLED' as const};
    const next = transitionWorkflow(session, event, timestamp);
    const record: WorkflowEventRecord = {
      id: randomUUID(),
      sessionId,
      timestamp,
      previousState: session.state,
      nextState: next.state,
      event,
    };
    await store.commitTransition(session, next, record);
    write(`Task ${sessionId} cancelled. Its worktree was preserved.\n`);
  } finally {
    store.close();
  }
};

export const taskResumeCommand = async (
  sessionId: string,
  write: (message: string) => void,
): Promise<void> => {
  const store = await openStore();
  const terminal = createInterface({input: process.stdin, output: process.stdout});
  let supervisor: ReturnType<typeof createRuntimeSupervisor> | undefined;
  let worker: ReturnType<typeof createRuntimeWorker> | undefined;
  try {
    const snapshot = await store.loadResumeSnapshot(sessionId);
    if (snapshot === undefined) throw new ConfigurationError(`Task ${sessionId} was not found.`);
    const interaction = new PlainWorkflowInteraction({terminal, write, json: false});
    let id = 0;
    const now = (): string => new Date().toISOString();
    const nextId = (): string => `${sessionId}:resume:${String(++id)}`;
    const applyOptions = {
      snapshot,
      store,
      interaction,
      collectDiff: collectWorkspaceDiff,
      applyChanges: async (workspace: NonNullable<typeof snapshot.workspace>) =>
        await applyWorkspaceChanges({
          workspace,
          sourceProjectRoot: snapshot.session.projectRoot,
          approved: true,
        }),
      discardWorkspace: async (workspace: NonNullable<typeof snapshot.workspace>) =>
        workspace.mode === 'snapshot'
          ? await discardSnapshotWorkspace(workspace)
          : await discardGitWorkspace(workspace),
      now,
      nextId,
    };
    const lastPause = [...snapshot.events]
      .reverse()
      .find(({event}) => event.type === 'TASK_PAUSED');
    const resumeState =
      snapshot.session.state === 'PAUSED' ? lastPause?.previousState : snapshot.session.state;
    const completed =
      resumeState === 'TECHNICALLY_APPROVED' ||
      resumeState === 'AWAITING_APPLY_APPROVAL' ||
      resumeState === 'APPLYING_CHANGES'
        ? await resumeApplyWorkflow(applyOptions)
        : await (async () => {
            const paths = getAgentForemanPlatformPaths();
            const config = await loadResolvedConfig({projectRoot: snapshot.session.projectRoot});
            supervisor = createRuntimeSupervisor(config, path.join(paths.dataDirectory, 'cache'));
            worker = createRuntimeWorker(config, path.join(paths.dataDirectory, 'cache'));
            const [supervisorHealth, workerHealth] = await Promise.all([
              supervisor.healthCheck(),
              worker.healthCheck(),
            ]);
            if (supervisorHealth.status === 'FAIL' || workerHealth.status === 'FAIL') {
              throw new ConfigurationError(
                `Resume provider health failed: ${supervisorHealth.message}; ${workerHealth.message}`,
              );
            }
            const projectSummary = await summarizeRepository(snapshot.session.projectRoot);
            const executionMode = resolveWorkspaceExecutionMode(
              config.workspace.mode,
              projectSummary.vcs,
            );
            const gates = await resolveQualityGateDefinitions(config, snapshot.session.projectRoot);
            const abortController = new AbortController();
            const context: ProviderExecutionContext = {
              sessionId,
              projectRoot: snapshot.session.projectRoot,
              timeoutMs: 30 * 60 * 1_000,
              abortSignal: abortController.signal,
              permissions: {
                filesystem: 'read-only',
                shell: 'read-only-allowlist',
                network: 'denied',
                workerLaunch: 'denied',
              },
              environmentAllowlist: runtimeEnvironmentAllowlist,
              logger: {
                error: (message) => {
                  write(`ERROR ${message}\n`);
                },
                warn: (message) => {
                  write(`WARN ${message}\n`);
                },
                info: () => undefined,
                debug: () => undefined,
                trace: () => undefined,
              },
              emit: (event) => {
                interaction.notify(event.type, event.metadata);
              },
              providerSessionMetadata: {},
            };
            const resumeOptions = {
              ...applyOptions,
              snapshot,
              projectSummary,
              supervisor,
              worker,
              supervisorContext: context,
              runQualityGates: async (workspacePath: string) =>
                await runQualityGates({
                  workspacePath,
                  gates,
                  signal: abortController.signal,
                  environmentAllowlist: runtimeEnvironmentAllowlist,
                }),
              limits: config.workflow,
              reviewPolicy: {
                allowOpenMedium: config.quality.allowOpenMedium,
                allowOpenLow: config.quality.allowOpenLow,
              },
            };
            const planningStates = new Set([
              'CREATED',
              'DISCOVERING_REPOSITORY',
              'REQUIREMENT_DISCOVERY',
              'DRAFTING_PLAN',
              'AWAITING_PLAN_REVIEW',
              'REVISING_PLAN',
              'PLAN_APPROVED',
              'PREPARING_WORKSPACE',
            ]);
            if (resumeState !== undefined && planningStates.has(resumeState)) {
              return await resumePlanningWorkflow({
                ...resumeOptions,
                prepareWorkspace: async () =>
                  executionMode === 'worktree'
                    ? await prepareGitWorkspace({
                        projectRoot: projectSummary.root,
                        taskId: sessionId,
                        dataDirectory: paths.dataDirectory,
                        dirtyStrategy: 'head-worktree',
                      })
                    : await prepareSnapshotWorkspace({
                        projectRoot: projectSummary.root,
                        taskId: sessionId,
                        dataDirectory: paths.dataDirectory,
                      }),
              });
            }
            return await resumeExecutionWorkflow(resumeOptions);
          })();
    write(`Task ${sessionId}: ${completed.state}.\n`);
  } finally {
    await supervisor?.dispose();
    await worker?.dispose();
    terminal.close();
    store.close();
  }
};

export const providerListCommand = async (write: (message: string) => void): Promise<void> => {
  const config = await loadResolvedConfig({projectRoot: process.cwd()});
  write(
    `supervisor  ${config.supervisor.provider}  ${config.supervisor.model ?? 'MODEL NOT SET'}\n`,
  );
  write(`worker      ${config.worker.provider}  ${config.worker.model ?? 'MODEL NOT SET'}\n`);
};

export const providerDoctorCommand = async (write: (message: string) => void): Promise<void> => {
  const paths = getAgentForemanPlatformPaths();
  const config = await loadResolvedConfig({projectRoot: process.cwd()});
  const supervisor = createRuntimeSupervisor(config, path.join(paths.dataDirectory, 'cache'));
  const worker = createRuntimeWorker(config, path.join(paths.dataDirectory, 'cache'));
  try {
    for (const [role, health] of await Promise.all([
      supervisor.healthCheck().then((health) => ['supervisor', health] as const),
      worker.healthCheck().then((health) => ['worker', health] as const),
    ])) {
      write(`${health.status} ${role}: ${health.message}\n`);
    }
  } finally {
    await supervisor.dispose();
    await worker.dispose();
  }
};

export const providerModelsCommand = async (
  role: string,
  write: (message: string) => void,
): Promise<void> => {
  const paths = getAgentForemanPlatformPaths();
  const config = await loadResolvedConfig({projectRoot: process.cwd()});
  if (role === 'supervisor') {
    const supervisor = createRuntimeSupervisor(config, path.join(paths.dataDirectory, 'cache'));
    try {
      const descriptor = await supervisor.descriptor();
      if (!descriptor.capabilities.modelDiscovery) {
        write(
          'SKIP supervisor: provider does not expose model discovery; configure and health-check the exact model name.\n',
        );
        return;
      }
      throw new ConfigurationError(
        'Codex reported model discovery but this adapter has no validated discovery command.',
      );
    } finally {
      await supervisor.dispose();
    }
    return;
  }
  if (role !== 'worker') throw new ConfigurationError('Role must be supervisor or worker.');
  const worker = createRuntimeWorker(config, path.join(paths.dataDirectory, 'cache'));
  try {
    const models = await worker.discoverModels();
    if (models.length === 0)
      write('SKIP worker: provider did not return model discovery results.\n');
    for (const model of models) write(`${model.id}\n`);
  } finally {
    await worker.dispose();
  }
};
