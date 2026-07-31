import {constants as fsConstants} from 'node:fs';
import {access, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

import {BinaryNotFoundError} from '@agent-foreman/core';

export interface BinaryDiscoveryInput {
  readonly binaryName: string;
  readonly currentExecutablePath?: string;
  readonly excludedDirectories?: readonly string[];
  readonly pathValue?: string;
  readonly platform?: NodeJS.Platform;
  readonly pathExtensions?: readonly string[];
}

const resolveIfPresent = async (candidate: string): Promise<string | undefined> => {
  try {
    return await realpath(candidate);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const isWithinDirectory = (candidate: string, directory: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
};

const executableNames = (
  binaryName: string,
  platform: NodeJS.Platform,
  pathExtensions: readonly string[] | undefined,
): readonly string[] => {
  if (platform !== 'win32') return [binaryName];
  if (path.extname(binaryName) !== '') return [binaryName];
  const extensions = pathExtensions ?? ['.COM', '.EXE', '.BAT', '.CMD'];
  return extensions.map((extension) => `${binaryName}${extension.toLowerCase()}`);
};

export const discoverBinary = async (input: BinaryDiscoveryInput): Promise<string> => {
  if (input.binaryName.trim() === '' || path.basename(input.binaryName) !== input.binaryName) {
    throw new BinaryNotFoundError('Binary discovery requires a bare executable name.', {
      diagnostics: {binaryName: input.binaryName},
    });
  }
  const platform = input.platform ?? process.platform;
  const currentExecutable =
    input.currentExecutablePath === undefined
      ? undefined
      : await resolveIfPresent(path.resolve(input.currentExecutablePath));
  const excludedDirectories = (
    await Promise.all(
      (input.excludedDirectories ?? []).map(
        async (directory) =>
          (await resolveIfPresent(path.resolve(directory))) ?? path.resolve(directory),
      ),
    )
  ).map((directory) => path.normalize(directory));
  const searched: string[] = [];

  for (const directory of (input.pathValue ?? process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const resolvedDirectory =
      (await resolveIfPresent(path.resolve(directory))) ?? path.resolve(directory);
    if (excludedDirectories.some((excluded) => isWithinDirectory(resolvedDirectory, excluded))) {
      continue;
    }
    for (const name of executableNames(input.binaryName, platform, input.pathExtensions)) {
      const candidate = path.join(resolvedDirectory, name);
      searched.push(candidate);
      const resolvedCandidate = await resolveIfPresent(candidate);
      if (resolvedCandidate === undefined || resolvedCandidate === currentExecutable) continue;
      if (excludedDirectories.some((excluded) => isWithinDirectory(resolvedCandidate, excluded))) {
        continue;
      }
      try {
        const candidateStat = await stat(resolvedCandidate);
        if (!candidateStat.isFile()) continue;
        if (platform !== 'win32') await access(resolvedCandidate, fsConstants.X_OK);
        return resolvedCandidate;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') continue;
        throw error;
      }
    }
  }

  throw new BinaryNotFoundError(`Could not find a safe real binary for ${input.binaryName}.`, {
    diagnostics: {binaryName: input.binaryName, searched},
  });
};
