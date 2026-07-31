import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';

import type {QualityGateConfig, ResolvedConfig} from '@agent-foreman/config';
import type {QualityGateReport, TaskSession, WorkflowEventRecord} from '@agent-foreman/contracts';
import {ConfigurationError, transitionWorkflow} from '@agent-foreman/core';
import {SqliteWorkflowStore} from '@agent-foreman/persistence';
import {getAgentForemanPlatformPaths} from '@agent-foreman/process';
import type {ProviderExecutionContext} from '@agent-foreman/provider-sdk';
import {
  discoverQualityGates,
  runQualityGates,
  type QualityGateDefinition,
} from '@agent-foreman/quality-gates';
import {
  applyWorkspaceChanges,
  collectWorkspaceDiff,
  discardGitWorkspace,
  discardSnapshotWorkspace,
  discoverGitRepository,
  prepareGitWorkspace,
  prepareSnapshotWorkspace,
  type DirtyWorkspaceStrategy,
} from '@agent-foreman/workspace';

import {PlainWorkflowInteraction} from '../workflow/plain-interaction.js';
import {summarizeRepository} from '../workflow/repository-summary.js';
import {runRealWorkflow, type RealWorkflowInteraction} from '../workflow/run-real-workflow.js';
import {createInkWorkflowInteraction, type InkWorkflowHandle} from '../tui/workflow-tui.js';
import {createRuntimeSupervisor, createRuntimeWorker} from './runtime-providers.js';
import {ensureConfiguredProfile} from './settings.js';

export interface RealRunCliOptions {
  readonly plain?: boolean;
  readonly output?: string;
  readonly profile?: string;
  readonly supervisor?: string;
  readonly supervisorModel?: string;
  readonly worker?: string;
  readonly workerModel?: string;
  readonly task?: string;
  readonly resume?: string;
  readonly color?: boolean;
}

const configuredGates = (values: readonly QualityGateConfig[]): readonly QualityGateDefinition[] =>
  values.flatMap((gate) => {
    if (gate.command === undefined) {
      if (
        gate.type === 'secret-scan' ||
        gate.type === 'scope-check' ||
        gate.type === 'changed-files-check' ||
        gate.type === 'diff-size-check'
      ) {
        return [];
      }
      throw new ConfigurationError(
        `Quality gate ${gate.id} requires a command array in the current runtime.`,
      );
    }
    const [executable, ...args] = gate.command;
    if (executable === undefined || executable.trim() === '') {
      throw new ConfigurationError(`Quality gate ${gate.id} has no executable.`);
    }
    return [
      {
        id: gate.id,
        type: gate.type,
        command: [executable, ...args],
        required: gate.required ?? true,
        timeoutMs: (gate.timeoutSeconds ?? 300) * 1_000,
      },
    ];
  });

export const resolveQualityGateDefinitions = async (
  config: ResolvedConfig,
  projectRoot: string,
): Promise<readonly QualityGateDefinition[]> =>
  config.quality.gates.length === 0
    ? await discoverQualityGates(projectRoot)
    : configuredGates(config.quality.gates);

export const runtimeEnvironmentAllowlist = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'NO_COLOR',
] as const;

export const resolveWorkspaceExecutionMode = (
  configuredMode: ResolvedConfig['workspace']['mode'],
  vcs: 'git' | 'none',
): 'worktree' | 'snapshot' => {
  if (configuredMode === 'current') {
    throw new ConfigurationError(
      'workspace.mode=current is incompatible with separate apply approval; use smart or snapshot.',
    );
  }
  if (configuredMode === 'snapshot') return 'snapshot';
  if (configuredMode === 'worktree' && vcs !== 'git') {
    throw new ConfigurationError('workspace.mode=worktree requires a Git repository.');
  }
  return vcs === 'git' ? 'worktree' : 'snapshot';
};

const pauseAfterFailure = async (
  store: SqliteWorkflowStore,
  sessionId: string,
  reason: string,
): Promise<void> => {
  const session = await store.getSession(sessionId);
  if (
    session === undefined ||
    session.state === 'PAUSED' ||
    session.state === 'COMPLETED' ||
    session.state === 'FAILED' ||
    session.state === 'CANCELLED'
  ) {
    return;
  }
  const timestamp = new Date().toISOString();
  const event = {type: 'TASK_PAUSED' as const, reason};
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
};

const dirtyStrategy = async (
  projectRoot: string,
  terminal: ReturnType<typeof createInterface>,
  announce: (message: string, details: Readonly<Record<string, unknown>>) => void,
): Promise<DirtyWorkspaceStrategy> => {
  const discovery = await discoverGitRepository(projectRoot);
  if (discovery.kind !== 'git' || discovery.clean) return 'head-worktree';
  announce(
    `Repository is dirty: ${String(discovery.trackedChanges.length)} tracked and ${String(discovery.untrackedFiles.length)} untracked files.\n`,
    {
      trackedChanges: discovery.trackedChanges,
      untrackedFiles: discovery.untrackedFiles,
    },
  );
  for (;;) {
    const answer = (
      await terminal.question('Workspace (/head from HEAD, /include tracked changes, /cancel): ')
    ).trim();
    if (answer === '/head') return 'head-worktree';
    if (answer === '/include') return 'include-tracked';
    if (answer === '/cancel') return 'cancel';
  }
};

export const runRealCliWorkflow = async (
  frontendProvider: string,
  options: RealRunCliOptions,
): Promise<void> => {
  if (options.resume !== undefined) {
    throw new ConfigurationError('Use `af task resume <id>` to resume a persisted task.');
  }
  const projectRoot = process.cwd();
  const jsonOutput = options.output === 'json';
  const writeRuntime = (
    event: string,
    human: string,
    details?: Readonly<Record<string, unknown>>,
  ): void => {
    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify({event, timestamp: new Date().toISOString(), details})}\n`
        : human,
    );
  };
  const cli = {
    ...(options.profile === undefined ? {} : {profileName: options.profile}),
    ...(options.supervisor === undefined ? {} : {supervisorProvider: options.supervisor}),
    ...(options.supervisorModel === undefined ? {} : {supervisorModel: options.supervisorModel}),
    ...(options.worker === undefined ? {} : {workerProvider: options.worker}),
    ...(options.workerModel === undefined ? {} : {workerModel: options.workerModel}),
  };
  const config = await ensureConfiguredProfile({
    projectRoot,
    cli,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    output: options.output ?? 'human',
    noColor: options.color === false || process.env.NO_COLOR !== undefined,
  });
  const paths = getAgentForemanPlatformPaths();
  const terminal = createInterface({
    input: process.stdin,
    output: jsonOutput ? process.stderr : process.stdout,
  });
  const taskId = randomUUID();
  const store = await SqliteWorkflowStore.open({
    databasePath: path.join(paths.stateDirectory, 'state.sqlite3'),
    auditLogPath: path.join(paths.stateDirectory, 'events.jsonl'),
  });
  const supervisor = createRuntimeSupervisor(config, path.join(paths.dataDirectory, 'cache'));
  const worker = createRuntimeWorker(config, path.join(paths.dataDirectory, 'cache'));
  const abortController = new AbortController();
  let inkHandle: InkWorkflowHandle | undefined;
  let terminalClosed = false;
  const onInterrupt = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    const [supervisorHealth, workerHealth] = await Promise.all([
      supervisor.healthCheck(),
      worker.healthCheck(),
    ]);
    writeRuntime(
      'provider.health',
      `Supervisor: ${supervisorHealth.status} — ${supervisorHealth.message}\n`,
      {role: 'supervisor', health: supervisorHealth},
    );
    writeRuntime('provider.health', `Worker: ${workerHealth.status} — ${workerHealth.message}\n`, {
      role: 'worker',
      health: workerHealth,
    });
    if (supervisorHealth.status === 'FAIL' || workerHealth.status === 'FAIL') {
      throw new ConfigurationError('Provider health checks must pass before starting a task.');
    }
    const request = options.task?.trim() ?? (await terminal.question('Task: ')).trim();
    if (request === '') throw new ConfigurationError('Task cannot be empty.');
    const summary = await summarizeRepository(projectRoot);
    const createdAt = new Date().toISOString();
    const session: TaskSession = {
      id: taskId,
      createdAt,
      updatedAt: createdAt,
      projectRoot: summary.root,
      userRequest: request,
      frontendProvider,
      supervisorProvider: config.supervisor.provider,
      ...(config.supervisor.model === undefined ? {} : {supervisorModel: config.supervisor.model}),
      workerProvider: config.worker.provider,
      ...(config.worker.model === undefined ? {} : {workerModel: config.worker.model}),
      profileName: config.activeProfile,
      state: 'CREATED',
      iteration: 0,
    };
    const usePlain =
      options.plain === true || jsonOutput || !process.stdin.isTTY || !process.stdout.isTTY;
    let interaction: RealWorkflowInteraction;
    if (usePlain) {
      interaction = new PlainWorkflowInteraction({
        terminal,
        write: (message) => process.stdout.write(message),
        json: jsonOutput,
      });
    } else {
      terminal.close();
      terminalClosed = true;
      inkHandle = createInkWorkflowInteraction({
        projectRoot: summary.root,
        supervisor: `${config.supervisor.provider} / ${config.supervisor.model ?? 'MODEL NOT SET'}`,
        worker: `${config.worker.provider} / ${config.worker.model ?? 'MODEL NOT SET'}`,
        profile: config.activeProfile,
        noColor: options.color === false || process.env.NO_COLOR !== undefined,
        screenReader: process.env.INK_SCREEN_READER === 'true',
        abort: () => {
          abortController.abort();
        },
      });
      interaction = inkHandle.interaction;
    }
    const context: ProviderExecutionContext = {
      sessionId: taskId,
      projectRoot: summary.root,
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
        error: (message) => process.stderr.write(`ERROR ${message}\n`),
        warn: (message) => process.stderr.write(`WARN ${message}\n`),
        info: (message) => {
          if (config.general.logLevel === 'debug' || config.general.logLevel === 'trace') {
            process.stderr.write(`INFO ${message}\n`);
          }
        },
        debug: () => undefined,
        trace: () => undefined,
      },
      emit: (event) => {
        interaction.notify(event.type, event.metadata);
      },
      providerSessionMetadata: {},
    };
    const gates = await resolveQualityGateDefinitions(config, summary.root);
    writeRuntime(
      'quality_gates.discovered',
      gates.length === 0
        ? 'Quality gates: none discovered; acceptance still requires supervisor evidence.\n'
        : `Quality gates: ${gates.map(({id}) => id).join(', ')}\n`,
      {gates: gates.map(({id, type, required}) => ({id, type, required}))},
    );
    const executionMode = resolveWorkspaceExecutionMode(config.workspace.mode, summary.vcs);
    const strategy =
      executionMode === 'worktree'
        ? await dirtyStrategy(summary.root, terminal, (message, details) => {
            writeRuntime('workspace.dirty', message, details);
          })
        : 'head-worktree';
    if (strategy === 'cancel')
      throw new ConfigurationError('Task cancelled before workspace creation.');
    let recordIndex = 0;
    const completed = await runRealWorkflow({
      session,
      userRequest: request,
      projectSummary: summary,
      supervisor,
      worker,
      supervisorContext: context,
      store,
      interaction,
      prepareWorkspace: async () =>
        executionMode === 'worktree'
          ? await prepareGitWorkspace({
              projectRoot: summary.root,
              taskId,
              dataDirectory: paths.dataDirectory,
              dirtyStrategy: strategy,
            })
          : await prepareSnapshotWorkspace({
              projectRoot: summary.root,
              taskId,
              dataDirectory: paths.dataDirectory,
            }),
      collectDiff: collectWorkspaceDiff,
      runQualityGates: async (workspacePath): Promise<QualityGateReport> =>
        await (async () => {
          interaction.notify('quality_gate.started');
          const report = await runQualityGates({
            workspacePath,
            gates,
            signal: abortController.signal,
            environmentAllowlist: runtimeEnvironmentAllowlist,
          });
          interaction.notify('quality_gate.completed', {status: report.status});
          return report;
        })(),
      applyChanges: async (workspace) =>
        await applyWorkspaceChanges({workspace, sourceProjectRoot: summary.root, approved: true}),
      discardWorkspace: async (workspace) =>
        workspace.mode === 'snapshot'
          ? await discardSnapshotWorkspace(workspace)
          : await discardGitWorkspace(workspace),
      limits: config.workflow,
      reviewPolicy: {
        allowOpenMedium: config.quality.allowOpenMedium,
        allowOpenLow: config.quality.allowOpenLow,
      },
      now: () => new Date().toISOString(),
      nextId: () => `${taskId}:${String(++recordIndex)}`,
    });
    inkHandle?.dispose();
    inkHandle = undefined;
    writeRuntime(
      'task.finished',
      `Task ${completed.id}: ${completed.state}${completed.workspace === undefined ? '' : `\nWorktree: ${completed.workspace.path}`}\n`,
      {session: completed},
    );
  } catch (error: unknown) {
    await pauseAfterFailure(
      store,
      taskId,
      abortController.signal.aborted
        ? 'Interrupted by the user; execution workspace was preserved.'
        : error instanceof Error
          ? error.message
          : 'Unexpected runtime failure.',
    );
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    inkHandle?.dispose();
    if (!terminalClosed) terminal.close();
    await supervisor.dispose();
    await worker.dispose();
    store.close();
  }
};
