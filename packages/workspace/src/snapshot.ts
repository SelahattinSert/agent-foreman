import {createHash} from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  ChangedFileSchema,
  ExecutionWorkspaceSchema,
  type ChangedFile,
  type ExecutionWorkspace,
} from '@agent-foreman/contracts';
import {
  ApplyConflictError,
  PermissionDeniedError,
  WorkspaceConflictError,
  WorkspacePreparationError,
} from '@agent-foreman/core';
import {runProcess} from '@agent-foreman/process';

import type {ApplyWorkspaceChangesResult} from './apply.js';
import type {WorkspaceDiff} from './diff.js';
import {canonicalPath} from './path-identity.js';

const manifestVersion = 1 as const;
const safeTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const excludedDirectoryNames = new Set(['.git', 'node_modules', '.agent-foreman']);
const sensitivePathPattern =
  /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/iu;
const maximumFileBytes = 5 * 1024 * 1024;

interface SnapshotFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

interface SnapshotManifest {
  readonly version: typeof manifestVersion;
  readonly sourceProjectRoot: string;
  readonly files: readonly SnapshotFile[];
  readonly excludedPaths: readonly string[];
}

const hashFile = async (filePath: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');

const walk = async (
  root: string,
  options: {readonly excludeSensitive: boolean},
): Promise<{readonly files: SnapshotFile[]; readonly excluded: string[]}> => {
  const files: SnapshotFile[] = [];
  const excluded: string[] = [];
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = await opendir(path.join(root, relativeDirectory));
    for await (const entry of directory) {
      const relativePath = path.posix.join(
        relativeDirectory.split(path.sep).join(path.posix.sep),
        entry.name,
      );
      if (entry.isDirectory()) {
        if (excludedDirectoryNames.has(entry.name)) {
          excluded.push(relativePath);
        } else {
          await visit(relativePath.split(path.posix.sep).join(path.sep));
        }
        continue;
      }
      if (!entry.isFile()) {
        excluded.push(relativePath);
        continue;
      }
      if (options.excludeSensitive && sensitivePathPattern.test(relativePath)) {
        excluded.push(relativePath);
        continue;
      }
      const absolutePath = path.join(root, ...relativePath.split(path.posix.sep));
      const metadata = await stat(absolutePath);
      if (metadata.size > maximumFileBytes) {
        excluded.push(relativePath);
        continue;
      }
      files.push({
        path: relativePath,
        sha256: await hashFile(absolutePath),
        size: metadata.size,
        mode: metadata.mode & 0o777,
      });
    }
  };
  await visit('');
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    excluded: excluded.sort(),
  };
};

const copyFiles = async (
  sourceRoot: string,
  targetRoot: string,
  files: readonly SnapshotFile[],
): Promise<void> => {
  for (const file of files) {
    const target = path.join(targetRoot, ...file.path.split(path.posix.sep));
    await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
    await copyFile(path.join(sourceRoot, ...file.path.split(path.posix.sep)), target);
  }
};

const readManifest = async (workspace: ExecutionWorkspace): Promise<SnapshotManifest> => {
  if (workspace.baselineManifestPath === undefined) {
    throw new WorkspacePreparationError('Snapshot workspace has no baseline manifest.');
  }
  const value = JSON.parse(await readFile(workspace.baselineManifestPath, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null) {
    throw new WorkspacePreparationError('Snapshot baseline manifest is invalid.');
  }
  const candidate = value as Partial<SnapshotManifest>;
  if (
    candidate.version !== manifestVersion ||
    typeof candidate.sourceProjectRoot !== 'string' ||
    !Array.isArray(candidate.files) ||
    !Array.isArray(candidate.excludedPaths)
  ) {
    throw new WorkspacePreparationError('Snapshot baseline manifest is invalid.');
  }
  return candidate as SnapshotManifest;
};

export interface PrepareSnapshotWorkspaceInput {
  readonly projectRoot: string;
  readonly taskId: string;
  readonly dataDirectory: string;
  readonly now?: () => string;
}

export const prepareSnapshotWorkspace = async (
  input: PrepareSnapshotWorkspaceInput,
): Promise<ExecutionWorkspace> => {
  if (!safeTaskIdPattern.test(input.taskId)) {
    throw new WorkspacePreparationError('Task ID is not safe for a snapshot path.');
  }
  const sourceRoot = await canonicalPath(input.projectRoot);
  const requestedDataDirectory = path.resolve(input.dataDirectory);
  await mkdir(requestedDataDirectory, {recursive: true, mode: 0o700});
  const dataDirectory = await canonicalPath(requestedDataDirectory);
  const snapshotRoot = path.join(dataDirectory, 'snapshots', input.taskId);
  try {
    await access(snapshotRoot);
    throw new WorkspaceConflictError('Snapshot workspace path already exists.', {
      diagnostics: {snapshotRoot},
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const baselineRoot = path.join(snapshotRoot, 'baseline');
  const workspaceRoot = path.join(snapshotRoot, 'workspace');
  await mkdir(baselineRoot, {recursive: true, mode: 0o700});
  await mkdir(workspaceRoot, {recursive: true, mode: 0o700});
  const scanned = await walk(sourceRoot, {excludeSensitive: true});
  await Promise.all([
    copyFiles(sourceRoot, baselineRoot, scanned.files),
    copyFiles(sourceRoot, workspaceRoot, scanned.files),
  ]);
  const manifest: SnapshotManifest = {
    version: manifestVersion,
    sourceProjectRoot: sourceRoot,
    files: scanned.files,
    excludedPaths: scanned.excluded,
  };
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return ExecutionWorkspaceSchema.parse({
    id: input.taskId,
    path: workspaceRoot,
    mode: 'snapshot',
    status: 'READY',
    sourceProjectRoot: sourceRoot,
    baselineManifestPath: manifestPath,
    snapshotBaselinePath: baselineRoot,
    excludedPaths: scanned.excluded,
    createdAt: input.now?.() ?? new Date().toISOString(),
  });
};

const changedFiles = (
  baseline: readonly SnapshotFile[],
  current: readonly SnapshotFile[],
): readonly ChangedFile[] => {
  const before = new Map(baseline.map((file) => [file.path, file]));
  const after = new Map(current.map((file) => [file.path, file]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((filePath) => {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    if (oldFile?.sha256 === newFile?.sha256) return [];
    return [
      ChangedFileSchema.parse({
        path: filePath,
        changeType:
          oldFile === undefined ? 'added' : newFile === undefined ? 'deleted' : 'modified',
      }),
    ];
  });
};

export const collectSnapshotWorkspaceDiff = async (
  workspace: ExecutionWorkspace,
): Promise<WorkspaceDiff> => {
  const manifest = await readManifest(workspace);
  const scanned = await walk(workspace.path, {excludeSensitive: false});
  const changes = changedFiles(manifest.files, scanned.files);
  const baselineRoot = workspace.snapshotBaselinePath;
  if (baselineRoot === undefined) {
    throw new WorkspacePreparationError('Snapshot workspace has no baseline copy.');
  }
  const result = await runProcess({
    executable: 'git',
    args: [
      'diff',
      '--no-index',
      '--binary',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
      baselineRoot,
      workspace.path,
    ],
    stdio: 'capture',
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new WorkspacePreparationError('Could not generate the snapshot diff.', {
      diagnostics: {exitCode: result.exitCode, stderr: result.stderr},
    });
  }
  const patch = result.stdout
    .replaceAll(`${baselineRoot}/`, '')
    .replaceAll(`${workspace.path}/`, '');
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return {
    patch,
    hash: createHash('sha256').update(patch).digest('hex'),
    changedFiles: changes,
    additions,
    deletions,
  };
};

const sameFileSet = (left: readonly SnapshotFile[], right: readonly SnapshotFile[]): boolean => {
  if (left.length !== right.length) return false;
  const rightMap = new Map(right.map((file) => [file.path, file.sha256]));
  return left.every((file) => rightMap.get(file.path) === file.sha256);
};

const readAndValidateSnapshotBaseline = async (
  workspace: ExecutionWorkspace,
  sourceProjectRoot: string,
): Promise<{readonly manifest: SnapshotManifest; readonly sourceRoot: string}> => {
  const manifest = await readManifest(workspace);
  const sourceRoot = await canonicalPath(sourceProjectRoot);
  const recordedSourceRoot = await canonicalPath(manifest.sourceProjectRoot);
  if (sourceRoot !== recordedSourceRoot) {
    throw new ApplyConflictError('Snapshot apply target does not match its recorded source.');
  }
  const source = await walk(sourceRoot, {excludeSensitive: true});
  if (!sameFileSet(manifest.files, source.files)) {
    throw new ApplyConflictError('Source files changed after the snapshot was created.');
  }
  return {manifest, sourceRoot};
};

export const validateSnapshotWorkspaceApply = async (
  workspace: ExecutionWorkspace,
  sourceProjectRoot: string,
): Promise<void> => {
  if (workspace.mode !== 'snapshot') {
    throw new WorkspacePreparationError(
      'A snapshot workspace is required for this apply validation.',
    );
  }
  await readAndValidateSnapshotBaseline(workspace, sourceProjectRoot);
};

export const applySnapshotWorkspaceChanges = async (input: {
  readonly workspace: ExecutionWorkspace;
  readonly sourceProjectRoot: string;
  readonly approved: boolean;
}): Promise<ApplyWorkspaceChangesResult> => {
  if (!input.approved)
    throw new PermissionDeniedError('Changes require explicit user apply approval.');
  const {sourceRoot} = await readAndValidateSnapshotBaseline(
    input.workspace,
    input.sourceProjectRoot,
  );
  const diff = await collectSnapshotWorkspaceDiff(input.workspace);
  const sensitiveChanges = diff.changedFiles.filter(({path: filePath}) =>
    sensitivePathPattern.test(filePath),
  );
  if (sensitiveChanges.length > 0) {
    throw new PermissionDeniedError('Snapshot changes include sensitive file paths.', {
      diagnostics: {paths: sensitiveChanges.map(({path: filePath}) => filePath)},
    });
  }
  const backupRoot = path.join(
    path.dirname(input.workspace.baselineManifestPath ?? input.workspace.path),
    `apply-backup-${String(Date.now())}`,
  );
  await mkdir(backupRoot, {recursive: true, mode: 0o700});
  const completed: ChangedFile[] = [];
  try {
    for (const change of diff.changedFiles) {
      const target = path.join(sourceRoot, ...change.path.split(path.posix.sep));
      const backup = path.join(backupRoot, ...change.path.split(path.posix.sep));
      await mkdir(path.dirname(backup), {recursive: true, mode: 0o700});
      if (change.changeType !== 'added') await rename(target, backup);
      if (change.changeType !== 'deleted') {
        await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
        const temporary = `${target}.${String(process.pid)}.af-apply`;
        await copyFile(
          path.join(input.workspace.path, ...change.path.split(path.posix.sep)),
          temporary,
        );
        await rename(temporary, target);
      }
      completed.push(change);
    }
  } catch (cause: unknown) {
    for (const change of [...completed].reverse()) {
      const target = path.join(sourceRoot, ...change.path.split(path.posix.sep));
      const backup = path.join(backupRoot, ...change.path.split(path.posix.sep));
      if (change.changeType === 'added') await rm(target, {force: true});
      else {
        await rm(target, {force: true});
        await rename(backup, target);
      }
    }
    throw new ApplyConflictError('Snapshot apply failed and completed writes were rolled back.', {
      cause,
      diagnostics: {backupRoot},
    });
  }
  await rm(backupRoot, {recursive: true, force: true});
  return {
    workspace: ExecutionWorkspaceSchema.parse({...input.workspace, status: 'APPLIED'}),
    diff,
  };
};

export const discardSnapshotWorkspace = async (
  rawWorkspace: ExecutionWorkspace,
): Promise<ExecutionWorkspace> => {
  const workspace = ExecutionWorkspaceSchema.parse(rawWorkspace);
  if (workspace.status === 'DISCARDED') return workspace;
  if (workspace.mode !== 'snapshot' || workspace.baselineManifestPath === undefined) {
    throw new WorkspacePreparationError('Only a recorded snapshot workspace can be discarded.');
  }
  const snapshotRoot = path.dirname(workspace.baselineManifestPath);
  if (!path.resolve(workspace.path).startsWith(`${path.resolve(snapshotRoot)}${path.sep}`)) {
    throw new WorkspacePreparationError('Snapshot workspace escaped its managed root.');
  }
  await rm(snapshotRoot, {recursive: true, force: true});
  return ExecutionWorkspaceSchema.parse({...workspace, status: 'DISCARDED'});
};
