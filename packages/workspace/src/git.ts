import {createHash} from 'node:crypto';
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

export const discoverGitRepository = async (projectRoot: string): Promise<RepositoryDiscovery> => {
  const requestedRoot = path.resolve(projectRoot);
  const rootResult = await runGit(requestedRoot, ['rev-parse', '--show-toplevel']);
  if (rootResult.exitCode !== 0) return {kind: 'none', projectRoot: requestedRoot};
  const resolvedRoot = path.resolve(rootResult.stdout.trim());
  const [commonRaw, headRaw, branchResult, status, trackedRaw, untrackedRaw] = await Promise.all([
    requireGit(resolvedRoot, ['rev-parse', '--git-common-dir']),
    requireGit(resolvedRoot, ['rev-parse', 'HEAD']),
    runGit(resolvedRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    requireGit(resolvedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    requireGit(resolvedRoot, ['diff', '--name-only', '-z', 'HEAD', '--']),
    requireGit(resolvedRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const commonValue = commonRaw.trim();
  const gitCommonDirectory = path.resolve(resolvedRoot, commonValue);
  const headRevision = headRaw.trim();
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : undefined;
  const baselineFingerprint = createHash('sha256')
    .update(headRevision)
    .update('\0')
    .update(branch ?? '')
    .update('\0')
    .update(status)
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
