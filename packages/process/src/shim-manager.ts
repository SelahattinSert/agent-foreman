import {createHash} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {ShimInstallationError} from '@agent-foreman/core';

const SHIM_METADATA_VERSION = 1 as const;
const providerIdPattern = /^[a-z0-9][a-z0-9._-]*$/u;

export interface ShimFileRecord {
  readonly path: string;
  readonly sha256: string;
}

export interface ShimMetadata {
  readonly version: typeof SHIM_METADATA_VERSION;
  readonly providerId: string;
  readonly binaryName: string;
  readonly realBinaryPath: string;
  readonly dispatcherEntrypoint: string;
  readonly nodeExecutable: string;
  readonly installedAt: string;
  readonly files: readonly ShimFileRecord[];
}

export interface InstallShimInput {
  readonly providerId: string;
  readonly binaryName: string;
  readonly realBinaryPath: string;
  readonly dispatcherEntrypoint: string;
  readonly nodeExecutable: string;
  readonly dataDirectory: string;
  readonly platform?: NodeJS.Platform;
}

export interface InstallShimResult {
  readonly created: boolean;
  readonly metadataPath: string;
  readonly shimDirectory: string;
  readonly shimPaths: readonly string[];
}

export interface ShimLocationInput {
  readonly providerId: string;
  readonly dataDirectory: string;
}

export type ShimInspection =
  | {readonly status: 'not-installed'}
  | {readonly status: 'installed'; readonly metadata: ShimMetadata}
  | {
      readonly status: 'modified';
      readonly metadata: ShimMetadata;
      readonly modifiedFiles: readonly string[];
    };

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const metadataPathFor = (dataDirectory: string, providerId: string): string =>
  path.join(dataDirectory, 'shims', `${providerId}.json`);

const assertProviderId = (providerId: string): void => {
  if (!providerIdPattern.test(providerId)) {
    throw new ShimInstallationError('Shim provider ID contains unsafe characters.', {
      diagnostics: {providerId},
    });
  }
};

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const powershellSingleQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const renderPosixShim = (
  nodeExecutable: string,
  dispatcherEntrypoint: string,
  metadataPath: string,
): string =>
  `#!/bin/sh\nexec ${shellSingleQuote(nodeExecutable)} ${shellSingleQuote(dispatcherEntrypoint)} --metadata ${shellSingleQuote(metadataPath)} -- "$@"\n`;

const cmdQuote = (value: string): string =>
  `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;

const renderCmdShim = (
  nodeExecutable: string,
  dispatcherEntrypoint: string,
  metadataPath: string,
): string =>
  `@echo off\r\n${cmdQuote(nodeExecutable)} ${cmdQuote(dispatcherEntrypoint)} --metadata ${cmdQuote(metadataPath)} -- %*\r\nexit /b %errorlevel%\r\n`;

const renderPowerShellShim = (
  nodeExecutable: string,
  dispatcherEntrypoint: string,
  metadataPath: string,
): string =>
  `& ${powershellSingleQuote(nodeExecutable)} ${powershellSingleQuote(dispatcherEntrypoint)} '--metadata' ${powershellSingleQuote(metadataPath)} '--' @args\nexit $LASTEXITCODE\n`;

const expectedShimFiles = (
  input: InstallShimInput,
  metadataPath: string,
): readonly {readonly path: string; readonly content: string; readonly mode: number}[] => {
  const directory = path.join(input.dataDirectory, 'bin');
  if ((input.platform ?? process.platform) === 'win32') {
    return [
      {
        path: path.join(directory, `${input.binaryName}.cmd`),
        content: renderCmdShim(input.nodeExecutable, input.dispatcherEntrypoint, metadataPath),
        mode: 0o644,
      },
      {
        path: path.join(directory, `${input.binaryName}.ps1`),
        content: renderPowerShellShim(
          input.nodeExecutable,
          input.dispatcherEntrypoint,
          metadataPath,
        ),
        mode: 0o644,
      },
    ];
  }
  return [
    {
      path: path.join(directory, input.binaryName),
      content: renderPosixShim(input.nodeExecutable, input.dispatcherEntrypoint, metadataPath),
      mode: 0o755,
    },
  ];
};

const atomicWrite = async (target: string, content: string, mode: number): Promise<void> => {
  const temporary = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(temporary, content, {mode, flag: 'wx'});
  await rename(temporary, target);
  await chmod(target, mode);
};

const parseMetadata = (raw: string, metadataPath: string): ShimMetadata => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause: unknown) {
    throw new ShimInstallationError('Shim metadata is not valid JSON.', {
      cause,
      diagnostics: {metadataPath},
    });
  }
  if (typeof value !== 'object' || value === null) {
    throw new ShimInstallationError('Shim metadata has an invalid shape.', {
      diagnostics: {metadataPath},
    });
  }
  const candidate = value as Partial<ShimMetadata>;
  if (
    candidate.version !== SHIM_METADATA_VERSION ||
    typeof candidate.providerId !== 'string' ||
    typeof candidate.binaryName !== 'string' ||
    typeof candidate.realBinaryPath !== 'string' ||
    typeof candidate.dispatcherEntrypoint !== 'string' ||
    typeof candidate.nodeExecutable !== 'string' ||
    typeof candidate.installedAt !== 'string' ||
    !Array.isArray(candidate.files) ||
    candidate.files.some(
      (file) =>
        typeof file !== 'object' ||
        file === null ||
        typeof (file as Partial<ShimFileRecord>).path !== 'string' ||
        typeof (file as Partial<ShimFileRecord>).sha256 !== 'string',
    )
  ) {
    throw new ShimInstallationError('Shim metadata has an invalid shape.', {
      diagnostics: {metadataPath},
    });
  }
  return candidate as ShimMetadata;
};

const readMetadata = async (metadataPath: string): Promise<ShimMetadata | undefined> => {
  try {
    return parseMetadata(await readFile(metadataPath, 'utf8'), metadataPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export const loadShimMetadata = async (metadataPath: string): Promise<ShimMetadata> => {
  const metadata = await readMetadata(path.resolve(metadataPath));
  if (metadata === undefined) {
    throw new ShimInstallationError('Shim metadata file was not found.', {
      diagnostics: {metadataPath},
    });
  }
  return metadata;
};

const modifiedFiles = async (metadata: ShimMetadata): Promise<readonly string[]> => {
  const modified: string[] = [];
  for (const file of metadata.files) {
    try {
      if (sha256(await readFile(file.path)) !== file.sha256) modified.push(file.path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        modified.push(file.path);
        continue;
      }
      throw error;
    }
  }
  return modified;
};

const assertRegularFile = async (filePath: string, label: string): Promise<string> => {
  const resolved = await realpath(path.resolve(filePath));
  if (!(await stat(resolved)).isFile()) {
    throw new ShimInstallationError(`${label} is not a regular file.`, {
      diagnostics: {filePath: resolved},
    });
  }
  return resolved;
};

export const installShim = async (input: InstallShimInput): Promise<InstallShimResult> => {
  assertProviderId(input.providerId);
  if (path.basename(input.binaryName) !== input.binaryName || input.binaryName.trim() === '') {
    throw new ShimInstallationError('Shim binary name must be a bare file name.');
  }
  const metadataPath = metadataPathFor(input.dataDirectory, input.providerId);
  const resolvedRealBinary = await assertRegularFile(input.realBinaryPath, 'Real provider binary');
  const resolvedDispatcher = await assertRegularFile(
    input.dispatcherEntrypoint,
    'Dispatcher entrypoint',
  );
  const resolvedNode = await assertRegularFile(input.nodeExecutable, 'Node executable');
  if ((input.platform ?? process.platform) !== 'win32') {
    await access(resolvedRealBinary, fsConstants.X_OK);
    await access(resolvedNode, fsConstants.X_OK);
  }
  const normalizedInput: InstallShimInput = {
    ...input,
    realBinaryPath: resolvedRealBinary,
    dispatcherEntrypoint: resolvedDispatcher,
    nodeExecutable: resolvedNode,
  };
  const files = expectedShimFiles(normalizedInput, metadataPath);
  if (files.some((file) => path.resolve(file.path) === resolvedRealBinary)) {
    throw new ShimInstallationError('Managed shim path would overwrite the real provider binary.');
  }

  const existingMetadata = await readMetadata(metadataPath);
  if (existingMetadata !== undefined) {
    const changed = await modifiedFiles(existingMetadata);
    const sameConfiguration =
      existingMetadata.providerId === input.providerId &&
      existingMetadata.binaryName === input.binaryName &&
      existingMetadata.realBinaryPath === resolvedRealBinary &&
      existingMetadata.dispatcherEntrypoint === resolvedDispatcher &&
      existingMetadata.nodeExecutable === resolvedNode;
    if (sameConfiguration && changed.length === 0) {
      return {
        created: false,
        metadataPath,
        shimDirectory: path.join(input.dataDirectory, 'bin'),
        shimPaths: existingMetadata.files.map((file) => file.path),
      };
    }
    throw new ShimInstallationError('A different or modified managed shim is already installed.', {
      diagnostics: {metadataPath, modifiedFiles: changed},
    });
  }

  await mkdir(path.dirname(metadataPath), {recursive: true, mode: 0o700});
  await mkdir(path.join(input.dataDirectory, 'bin'), {recursive: true, mode: 0o755});
  for (const file of files) {
    try {
      await access(file.path);
      throw new ShimInstallationError('Refusing to overwrite an unrelated executable.', {
        diagnostics: {shimPath: file.path},
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const records = files.map((file) => ({path: file.path, sha256: sha256(file.content)}));
  const metadata: ShimMetadata = {
    version: SHIM_METADATA_VERSION,
    providerId: input.providerId,
    binaryName: input.binaryName,
    realBinaryPath: resolvedRealBinary,
    dispatcherEntrypoint: resolvedDispatcher,
    nodeExecutable: resolvedNode,
    installedAt: new Date().toISOString(),
    files: records,
  };
  const created: string[] = [];
  try {
    for (const file of files) {
      await atomicWrite(file.path, file.content, file.mode);
      created.push(file.path);
    }
    await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
  } catch (cause: unknown) {
    for (const filePath of created) await unlink(filePath).catch(() => undefined);
    throw new ShimInstallationError('Shim installation did not complete atomically.', {
      cause,
      diagnostics: {metadataPath},
    });
  }

  return {
    created: true,
    metadataPath,
    shimDirectory: path.join(input.dataDirectory, 'bin'),
    shimPaths: records.map((record) => record.path),
  };
};

export const inspectShim = async (input: ShimLocationInput): Promise<ShimInspection> => {
  assertProviderId(input.providerId);
  const metadata = await readMetadata(metadataPathFor(input.dataDirectory, input.providerId));
  if (metadata === undefined) return {status: 'not-installed'};
  const changed = await modifiedFiles(metadata);
  return changed.length === 0
    ? {status: 'installed', metadata}
    : {status: 'modified', metadata, modifiedFiles: changed};
};

export const uninstallShim = async (
  input: ShimLocationInput,
): Promise<{readonly removed: boolean; readonly removedPaths: readonly string[]}> => {
  const inspection = await inspectShim(input);
  if (inspection.status === 'not-installed') return {removed: false, removedPaths: []};
  if (inspection.status === 'modified') {
    throw new ShimInstallationError('Refusing to remove a shim that changed after installation.', {
      diagnostics: {modifiedFiles: inspection.modifiedFiles},
    });
  }
  const metadataPath = metadataPathFor(input.dataDirectory, input.providerId);
  for (const file of inspection.metadata.files) await unlink(file.path);
  await unlink(metadataPath);
  return {
    removed: true,
    removedPaths: [...inspection.metadata.files.map((file) => file.path), metadataPath],
  };
};

export type ShellSetupTarget = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd';

export const renderShellSetup = (shimDirectory: string, shell: ShellSetupTarget): string => {
  switch (shell) {
    case 'bash':
    case 'zsh':
      return `export PATH=${shellSingleQuote(shimDirectory)}:"$PATH"`;
    case 'fish':
      return `fish_add_path --prepend ${shellSingleQuote(shimDirectory)}`;
    case 'powershell':
      return `$env:PATH = ${powershellSingleQuote(`${shimDirectory};`)} + $env:PATH`;
    case 'cmd':
      return `set "PATH=${shimDirectory};%PATH%"`;
  }
};
