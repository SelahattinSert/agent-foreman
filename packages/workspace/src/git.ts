import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';

import {WorkspacePreparationError} from '@agent-foreman/core';
import {runProcess, type ProcessRunResult} from '@agent-foreman/process';

export interface GitRepositoryDiscovery {
  readonly kind: 'git';
  readonly projectRoot: string;
  readonly gitCommonDirectory: string;
  readonly headRevision: string;
  readonly branch?: string;
  readonly clean: boolean;
  readonly status: string;
  readonly baselineFingerprint: string;
  readonly trackedChanges: readonly string[];
  readonly untrackedFiles: readonly string[];
}

export interface NonGitDiscovery {
  readonly kind: 'none';
  readonly projectRoot: string;
}

export type RepositoryDiscovery = GitRepositoryDiscovery | NonGitDiscovery;

export interface GitDiscoveryOptions {
  /** Managed Git worktree paths to exclude from the source repository's untracked status fingerprint. */
  readonly excludeUntrackedPaths?: readonly string[];
}

export const runGit = async (
  cwd: string,
  args: readonly string[],
  stdin?: string,
): Promise<ProcessRunResult> =>
  await runProcess({
    executable: 'git',
    args: ['-C', cwd, ...args],
    cwd,
    ...(stdin === undefined ? {} : {stdin}),
    stdio: 'capture',
  });

export const requireGit = async (
  cwd: string,
  args: readonly string[],
  stdin?: string,
): Promise<string> => {
  const result = await runGit(cwd, args, stdin);
  if (result.exitCode !== 0) {
    throw new WorkspacePreparationError(`Git command failed: git ${args.join(' ')}`, {
      diagnostics: {cwd, args, exitCode: result.exitCode, stderr: result.stderr},
    });
  }
  return result.stdout;
};

const nulList = (value: string): readonly string[] => value.split('\0').filter(Boolean);

const statusForFingerprint = (
  status: string,
  projectRoot: string,
  excludedPaths: readonly string[],
): string => {
  const excludedRelativePaths = new Set(
    excludedPaths
      .map((excludedPath) => path.relative(projectRoot, path.resolve(excludedPath)))
      .filter(
        (relativePath) =>
          relativePath !== '' &&
          relativePath !== '..' &&
          !relativePath.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativePath),
      )
      .map((relativePath) => relativePath.split(path.sep).join('/')),
  );
  if (excludedRelativePaths.size === 0) return status;

  const records = status.split('\0').filter(Boolean);
  const fingerprintRecords = records.filter((record) => {
    if (!record.startsWith('?? ')) return true;
    const relativePath = record.slice(3).replace(/\/$/u, '');
    return !excludedRelativePaths.has(relativePath);
  });
  return fingerprintRecords.length === 0 ? '' : `${fingerprintRecords.join('\0')}\0`;
};

export const discoverGitRepository = async (
  projectRoot: string,
  options: GitDiscoveryOptions = {},
): Promise<RepositoryDiscovery> => {
  const requestedRoot = path.resolve(projectRoot);
  const rootResult = await runGit(requestedRoot, ['rev-parse', '--show-toplevel']);
  if (rootResult.exitCode !== 0) return {kind: 'none', projectRoot: requestedRoot};
  const resolvedRoot = await realpath(path.resolve(rootResult.stdout.trim()));
  const [commonRaw, headRaw, branchResult, status, trackedRaw, untrackedRaw] = await Promise.all([
    requireGit(resolvedRoot, ['rev-parse', '--git-common-dir']),
    requireGit(resolvedRoot, ['rev-parse', 'HEAD']),
    runGit(resolvedRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    requireGit(resolvedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    requireGit(resolvedRoot, ['diff', '--name-only', '-z', 'HEAD', '--']),
    requireGit(resolvedRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const commonValue = commonRaw.trim();
  const gitCommonDirectory = await realpath(path.resolve(resolvedRoot, commonValue));
  const headRevision = headRaw.trim();
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
  const fingerprintStatus = statusForFingerprint(
    status,
    resolvedRoot,
    options.excludeUntrackedPaths ?? [],
  );
  const baselineFingerprint = createHash('sha256')
    .update(headRevision)
    .update('\0')
    .update(branch ?? '')
    .update('\0')
    .update(fingerprintStatus)
    .digest('hex');
  return {
    kind: 'git',
    projectRoot: resolvedRoot,
    gitCommonDirectory,
    headRevision,
    ...(branch === undefined ? {} : {branch}),
    clean: status === '',
    status,
    baselineFingerprint,
    trackedChanges: nulList(trackedRaw),
    untrackedFiles: nulList(untrackedRaw),
  };
};
