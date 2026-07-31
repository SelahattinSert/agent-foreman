import {createHash} from 'node:crypto';

import {
  ChangedFileSchema,
  type ChangedFile,
  type ExecutionWorkspace,
} from '@agent-foreman/contracts';
import {WorkspacePreparationError} from '@agent-foreman/core';

import {requireGit} from './git.js';
import {collectSnapshotWorkspaceDiff} from './snapshot.js';

export interface WorkspaceDiff {
  readonly patch: string;
  readonly hash: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly additions: number;
  readonly deletions: number;
}

const parseNameStatus = (raw: string): readonly ChangedFile[] => {
  const tokens = raw.split('\0').filter(Boolean);
  const changed: ChangedFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (status === undefined) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = tokens[index++];
      const filePath = tokens[index++];
      if (previousPath === undefined || filePath === undefined) {
        throw new WorkspacePreparationError('Git returned malformed rename metadata.');
      }
      changed.push(ChangedFileSchema.parse({path: filePath, previousPath, changeType: 'renamed'}));
      continue;
    }
    const filePath = tokens[index++];
    if (filePath === undefined) {
      throw new WorkspacePreparationError('Git returned malformed changed-file metadata.');
    }
    const changeType =
      status === 'A' ? 'added' : status === 'D' ? 'deleted' : ('modified' as const);
    changed.push(ChangedFileSchema.parse({path: filePath, changeType}));
  }
  return changed.sort((left, right) => left.path.localeCompare(right.path));
};

const parseNumstat = (raw: string): {readonly additions: number; readonly deletions: number} => {
  let additions = 0;
  let deletions = 0;
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const [added, deleted] = line.split('\t');
    if (added !== undefined && added !== '-') additions += Number(added);
    if (deleted !== undefined && deleted !== '-') deletions += Number(deleted);
  }
  return {additions, deletions};
};

export const collectWorkspaceDiff = async (
  workspace: ExecutionWorkspace,
): Promise<WorkspaceDiff> => {
  if (workspace.mode === 'snapshot') return await collectSnapshotWorkspaceDiff(workspace);
  if (workspace.mode !== 'worktree' || workspace.baseTree === undefined) {
    throw new WorkspacePreparationError('A Git worktree with a recorded base tree is required.');
  }
  const untracked = (
    await requireGit(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  if (untracked.length > 0) {
    await requireGit(workspace.path, ['add', '--intent-to-add', '--', ...untracked]);
  }
  const [patch, nameStatus, numstat] = await Promise.all([
    requireGit(workspace.path, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      workspace.baseTree,
      '--',
    ]),
    requireGit(workspace.path, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      workspace.baseTree,
      '--',
    ]),
    requireGit(workspace.path, ['diff', '--numstat', workspace.baseTree, '--']),
  ]);
  const counts = parseNumstat(numstat);
  return {
    patch,
    hash: createHash('sha256').update(patch).digest('hex'),
    changedFiles: parseNameStatus(nameStatus),
    additions: counts.additions,
    deletions: counts.deletions,
  };
};
