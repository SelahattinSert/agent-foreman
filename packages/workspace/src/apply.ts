import path from 'node:path';

import {ExecutionWorkspaceSchema, type ExecutionWorkspace} from '@agent-foreman/contracts';
import {
  ApplyConflictError,
  PermissionDeniedError,
  WorkspacePreparationError,
} from '@agent-foreman/core';

import {collectWorkspaceDiff, type WorkspaceDiff} from './diff.js';
import {discoverGitRepository, requireGit, runGit} from './git.js';
import {canonicalPath} from './path-identity.js';
import {applySnapshotWorkspaceChanges, validateSnapshotWorkspaceApply} from './snapshot.js';

const isWithinPath = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const isRegisteredWorktree = async (
  sourceRoot: string,
  workspacePath: string,
): Promise<boolean> => {
  const worktrees = await requireGit(sourceRoot, ['worktree', 'list', '--porcelain']);
  const recordedPaths = worktrees
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  const canonicalPaths = await Promise.all(
    recordedPaths.map(async (recordedPath) => {
      try {
        return await canonicalPath(recordedPath);
      } catch {
        return undefined;
      }
    }),
  );
  return canonicalPaths.includes(workspacePath);
};

export interface ApplyWorkspaceChangesInput {
  readonly workspace: ExecutionWorkspace;
  readonly sourceProjectRoot: string;
  readonly approved: boolean;
}

export interface ApplyWorkspaceChangesResult {
  readonly workspace: ExecutionWorkspace;
  readonly diff: WorkspaceDiff;
}

export const validateGitWorkspaceApply = async (
  workspace: ExecutionWorkspace,
  sourceProjectRoot: string,
): Promise<void> => {
  if (workspace.mode !== 'worktree') {
    throw new WorkspacePreparationError('A Git worktree is required for this apply validation.');
  }
  if (workspace.sourceProjectRoot === undefined) {
    throw new ApplyConflictError('Apply target does not match the workspace source repository.');
  }
  const sourceRoot = await canonicalPath(sourceProjectRoot);
  const recordedSourceRoot = await canonicalPath(workspace.sourceProjectRoot);
  if (sourceRoot !== recordedSourceRoot) {
    throw new ApplyConflictError('Apply target does not match the workspace source repository.');
  }
  if (workspace.baselineFingerprint === undefined) {
    throw new WorkspacePreparationError('Workspace is missing source baseline metadata.');
  }
  let workspacePath: string;
  try {
    workspacePath = await canonicalPath(workspace.path);
  } catch {
    throw new ApplyConflictError('Execution workspace no longer exists.');
  }
  if (
    isWithinPath(workspacePath, sourceRoot) ||
    !(await isRegisteredWorktree(sourceRoot, workspacePath))
  ) {
    throw new ApplyConflictError(
      'Execution workspace is not a registered worktree of the source repository.',
    );
  }
  const current = await discoverGitRepository(sourceRoot, {
    excludeUntrackedPaths: [workspacePath],
  });
  if (
    current.kind !== 'git' ||
    current.baselineFingerprint !== workspace.baselineFingerprint ||
    current.headRevision !== workspace.baseRevision
  ) {
    throw new ApplyConflictError('Source repository changed after workspace creation.', {
      diagnostics: {
        expectedFingerprint: workspace.baselineFingerprint,
        actualFingerprint: current.kind === 'git' ? current.baselineFingerprint : undefined,
      },
    });
  }
};

export const validateWorkspaceApply = async (
  workspace: ExecutionWorkspace,
  sourceProjectRoot: string,
): Promise<void> => {
  if (workspace.mode === 'snapshot') {
    await validateSnapshotWorkspaceApply(workspace, sourceProjectRoot);
    return;
  }
  if (workspace.mode === 'worktree') {
    await validateGitWorkspaceApply(workspace, sourceProjectRoot);
    return;
  }
  throw new WorkspacePreparationError('A managed execution workspace is required for apply.');
};

export const applyWorkspaceChanges = async (
  input: ApplyWorkspaceChangesInput,
): Promise<ApplyWorkspaceChangesResult> => {
  if (input.workspace.mode === 'snapshot') return await applySnapshotWorkspaceChanges(input);
  if (!input.approved) {
    throw new PermissionDeniedError('Changes require explicit user apply approval.');
  }
  const sourceRoot = await canonicalPath(input.sourceProjectRoot);
  await validateWorkspaceApply(input.workspace, sourceRoot);

  const diff = await collectWorkspaceDiff(input.workspace);
  if (diff.patch !== '') {
    const check = await runGit(sourceRoot, ['apply', '--check', '--binary', '-'], diff.patch);
    if (check.exitCode !== 0) {
      throw new ApplyConflictError('Changes no longer apply cleanly to the source workspace.', {
        diagnostics: {stderr: check.stderr},
      });
    }
    const applied = await runGit(
      sourceRoot,
      ['apply', '--binary', '--whitespace=nowarn', '-'],
      diff.patch,
    );
    if (applied.exitCode !== 0) {
      throw new ApplyConflictError('Git could not apply the verified patch.', {
        diagnostics: {stderr: applied.stderr},
      });
    }
  }
  return {
    workspace: ExecutionWorkspaceSchema.parse({...input.workspace, status: 'APPLIED'}),
    diff,
  };
};
