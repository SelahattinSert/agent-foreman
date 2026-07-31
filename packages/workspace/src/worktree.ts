import {access, mkdir} from 'node:fs/promises';
import path from 'node:path';

import {ExecutionWorkspaceSchema, type ExecutionWorkspace} from '@agent-foreman/contracts';
import {WorkspaceConflictError, WorkspacePreparationError} from '@agent-foreman/core';

import {discoverGitRepository, requireGit} from './git.js';

export type DirtyWorkspaceStrategy = 'cancel' | 'head-worktree' | 'include-tracked';

export interface PrepareGitWorkspaceInput {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly dataDirectory: string;
  readonly dirtyStrategy: DirtyWorkspaceStrategy;
  readonly allowSensitiveTrackedChanges?: readonly string[];
  readonly now?: () => string;
}

const safeTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sensitivePathPattern =
  /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/iu;

const assertAvailable = async (workspacePath: string): Promise<void> => {
  try {
    await access(workspacePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new WorkspaceConflictError('Execution workspace path already exists.', {
    diagnostics: {workspacePath},
  });
};

export const prepareGitWorkspace = async (
  input: PrepareGitWorkspaceInput,
): Promise<ExecutionWorkspace> => {
  if (!safeTaskIdPattern.test(input.taskId)) {
    throw new WorkspacePreparationError('Task ID is not safe for an execution workspace path.');
  }
  const repository = await discoverGitRepository(input.projectRoot);
  if (repository.kind !== 'git') {
    throw new WorkspacePreparationError('Project is not a Git repository.');
  }
  if (!repository.clean && input.dirtyStrategy === 'cancel') {
    throw new WorkspaceConflictError(
      'Repository has uncommitted changes and no safe strategy was approved.',
      {
        diagnostics: {
          trackedChanges: repository.trackedChanges,
          untrackedFiles: repository.untrackedFiles,
        },
      },
    );
  }
  const workspacePath = path.join(path.resolve(input.dataDirectory), 'worktrees', input.taskId);
  await assertAvailable(workspacePath);
  await mkdir(path.dirname(workspacePath), {recursive: true, mode: 0o700});
  await requireGit(repository.projectRoot, [
    'worktree',
    'add',
    '--detach',
    workspacePath,
    repository.headRevision,
  ]);

  let baseTree = repository.headRevision;
  let includedTrackedChanges = false;
  try {
    if (!repository.clean && input.dirtyStrategy === 'include-tracked') {
      const allowedSensitive = new Set(input.allowSensitiveTrackedChanges ?? []);
      const blockedSensitive = repository.trackedChanges.filter(
        (file) => sensitivePathPattern.test(file) && !allowedSensitive.has(file),
      );
      if (blockedSensitive.length > 0) {
        throw new WorkspaceConflictError(
          'Tracked sensitive files require separate explicit permission before snapshot inclusion.',
          {diagnostics: {blockedSensitive}},
        );
      }
      const patch = await requireGit(repository.projectRoot, [
        'diff',
        '--binary',
        '--full-index',
        'HEAD',
        '--',
      ]);
      if (patch !== '') await requireGit(workspacePath, ['apply', '--binary', '-'], patch);
      await requireGit(workspacePath, ['add', '-A', '--', '.']);
      baseTree = (await requireGit(workspacePath, ['write-tree'])).trim();
      includedTrackedChanges = true;
    }
  } catch (error: unknown) {
    await requireGit(repository.projectRoot, [
      'worktree',
      'remove',
      '--force',
      workspacePath,
    ]).catch(() => undefined);
    throw error;
  }

  return ExecutionWorkspaceSchema.parse({
    id: input.taskId,
    path: workspacePath,
    mode: 'worktree',
    status: 'READY',
    baseRevision: repository.headRevision,
    baseTree,
    sourceProjectRoot: repository.projectRoot,
    ...(repository.branch === undefined ? {} : {sourceBranch: repository.branch}),
    baselineFingerprint: repository.baselineFingerprint,
    includedTrackedChanges,
    excludedPaths: repository.untrackedFiles,
    createdAt: input.now?.() ?? new Date().toISOString(),
  });
};

export const discardGitWorkspace = async (
  rawWorkspace: ExecutionWorkspace,
): Promise<ExecutionWorkspace> => {
  const workspace = ExecutionWorkspaceSchema.parse(rawWorkspace);
  if (workspace.status === 'DISCARDED') return workspace;
  if (workspace.mode !== 'worktree' || workspace.sourceProjectRoot === undefined) {
    throw new WorkspacePreparationError('Only a recorded Git worktree can be discarded safely.');
  }
  const workspacePath = path.resolve(workspace.path);
  const sourceRoot = path.resolve(workspace.sourceProjectRoot);
  if (workspacePath === sourceRoot || sourceRoot.startsWith(`${workspacePath}${path.sep}`)) {
    throw new WorkspacePreparationError('Refusing to discard a source repository path.');
  }
  const registered = await requireGit(sourceRoot, ['worktree', 'list', '--porcelain']);
  const registeredPaths = registered
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
  if (registeredPaths.includes(workspacePath)) {
    await requireGit(sourceRoot, ['worktree', 'remove', '--force', workspacePath]);
  } else {
    try {
      await access(workspacePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return ExecutionWorkspaceSchema.parse({...workspace, status: 'DISCARDED'});
      }
      throw error;
    }
    throw new WorkspaceConflictError(
      'Workspace path exists but is no longer registered as the recorded Git worktree.',
      {diagnostics: {workspacePath}},
    );
  }
  return ExecutionWorkspaceSchema.parse({...workspace, status: 'DISCARDED'});
};
