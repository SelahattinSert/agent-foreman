import {ExecutionWorkspaceSchema, type ExecutionWorkspace} from '@agent-foreman/contracts';
import {
  ApplyConflictError,
  PermissionDeniedError,
  WorkspacePreparationError,
} from '@agent-foreman/core';

import {collectWorkspaceDiff, type WorkspaceDiff} from './diff.js';
import {discoverGitRepository, runGit} from './git.js';
import {canonicalPath} from './path-identity.js';
import {applySnapshotWorkspaceChanges} from './snapshot.js';

export interface ApplyWorkspaceChangesInput {
  readonly workspace: ExecutionWorkspace;
  readonly sourceProjectRoot: string;
  readonly approved: boolean;
}

export interface ApplyWorkspaceChangesResult {
  readonly workspace: ExecutionWorkspace;
  readonly diff: WorkspaceDiff;
}

export const applyWorkspaceChanges = async (
  input: ApplyWorkspaceChangesInput,
): Promise<ApplyWorkspaceChangesResult> => {
  if (input.workspace.mode === 'snapshot') return await applySnapshotWorkspaceChanges(input);
  if (!input.approved) {
    throw new PermissionDeniedError('Changes require explicit user apply approval.');
  }
  if (input.workspace.sourceProjectRoot === undefined) {
    throw new ApplyConflictError('Apply target does not match the workspace source repository.');
  }
  const sourceRoot = await canonicalPath(input.sourceProjectRoot);
  const recordedSourceRoot = await canonicalPath(input.workspace.sourceProjectRoot);
  if (sourceRoot !== recordedSourceRoot) {
    throw new ApplyConflictError('Apply target does not match the workspace source repository.');
  }
  if (input.workspace.baselineFingerprint === undefined) {
    throw new WorkspacePreparationError('Workspace is missing source baseline metadata.');
  }
  const current = await discoverGitRepository(sourceRoot);
  if (
    current.kind !== 'git' ||
    current.baselineFingerprint !== input.workspace.baselineFingerprint ||
    current.headRevision !== input.workspace.baseRevision
  ) {
    throw new ApplyConflictError('Source repository changed after workspace creation.', {
      diagnostics: {
        expectedFingerprint: input.workspace.baselineFingerprint,
        actualFingerprint: current.kind === 'git' ? current.baselineFingerprint : undefined,
      },
    });
  }

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
