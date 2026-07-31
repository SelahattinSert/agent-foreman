import {access, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';

import {ConfigurationError} from '@agent-foreman/core';
import {
  discoverBinary,
  getAgentForemanPlatformPaths,
  inspectShim,
  installShim,
  renderShellSetup,
  uninstallShim,
  type ShellSetupTarget,
} from '@agent-foreman/process';

const frontendBinaryNames: Readonly<Record<string, string>> = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
};

export interface ShimMutationOptions {
  readonly binary?: string;
  readonly yes?: boolean;
}

export interface ShimCommandIo {
  readonly write: (message: string) => void;
  readonly confirm?: (question: string) => Promise<boolean>;
}

const confirmInTerminal = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^y(?:es)?$/iu.test(answer.trim());
  } finally {
    prompt.close();
  }
};

const binaryNameFor = (providerId: string, override: string | undefined): string => {
  if (override !== undefined) return override;
  const binaryName = frontendBinaryNames[providerId];
  if (binaryName === undefined) {
    throw new ConfigurationError(
      `Unknown shim provider ${providerId}; provide its real binary with --binary.`,
    );
  }
  return binaryName;
};

const resolveRealBinary = async (
  binary: string,
  shimDirectory: string,
): Promise<{readonly binaryName: string; readonly realBinaryPath: string}> => {
  if (path.isAbsolute(binary)) {
    await access(binary);
    return {binaryName: path.basename(binary), realBinaryPath: await realpath(binary)};
  }
  if (path.basename(binary) !== binary) {
    throw new ConfigurationError(
      '--binary must be either an absolute path or a bare command name.',
    );
  }
  return {
    binaryName: binary,
    realBinaryPath: await discoverBinary({
      binaryName: binary,
      excludedDirectories: [shimDirectory],
    }),
  };
};

const dispatcherEntrypoint = async (): Promise<string> => {
  const candidates = [
    fileURLToPath(new URL('./dispatcher-main.js', import.meta.url)),
    fileURLToPath(new URL('../dispatcher-main.js', import.meta.url)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new ConfigurationError('Built Agent Foreman dispatcher entrypoint was not found.');
};

export const installShimCommand = async (
  providerId: string,
  options: ShimMutationOptions,
  io: ShimCommandIo,
): Promise<void> => {
  const paths = getAgentForemanPlatformPaths();
  const shimDirectory = path.join(paths.dataDirectory, 'bin');
  const configuredBinary = binaryNameFor(providerId, options.binary);
  const resolved = await resolveRealBinary(configuredBinary, shimDirectory);
  const binaryName = frontendBinaryNames[providerId] ?? resolved.binaryName;
  const expectedShimPath = path.join(
    shimDirectory,
    process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
  );
  io.write(
    [
      `Provider: ${providerId}`,
      `Real binary (unchanged): ${resolved.realBinaryPath}`,
      `Managed shim: ${expectedShimPath}`,
      'Shell startup files and PATH will not be edited automatically.',
      '',
    ].join('\n'),
  );
  const approved =
    options.yes === true ||
    (await (io.confirm ?? confirmInTerminal)('Install this managed dispatcher shim?'));
  if (!approved) throw new ConfigurationError('Shim installation was not approved.');

  const result = await installShim({
    providerId,
    binaryName,
    realBinaryPath: resolved.realBinaryPath,
    dispatcherEntrypoint: await dispatcherEntrypoint(),
    nodeExecutable: process.execPath,
    dataDirectory: paths.dataDirectory,
  });
  io.write(result.created ? 'Shim installed.\n' : 'Shim is already installed and unchanged.\n');
  io.write('Prepend the managed directory to PATH with:\n');
  io.write(`${renderShellSetup(result.shimDirectory, detectShell())}\n`);
};

export const uninstallShimCommand = async (
  providerId: string,
  options: Pick<ShimMutationOptions, 'yes'>,
  io: ShimCommandIo,
): Promise<void> => {
  const dataDirectory = getAgentForemanPlatformPaths().dataDirectory;
  const inspection = await inspectShim({providerId, dataDirectory});
  if (inspection.status === 'not-installed') {
    io.write(`No managed ${providerId} shim is installed.\n`);
    return;
  }
  if (inspection.status === 'modified') {
    throw new ConfigurationError(
      `The managed ${providerId} shim was modified; it will not be deleted automatically.`,
    );
  }
  io.write(
    `Managed files to remove:\n${inspection.metadata.files.map((file) => `- ${file.path}`).join('\n')}\n`,
  );
  const approved =
    options.yes === true ||
    (await (io.confirm ?? confirmInTerminal)('Remove these managed shim files?'));
  if (!approved) throw new ConfigurationError('Shim removal was not approved.');
  const result = await uninstallShim({providerId, dataDirectory});
  io.write(
    result.removed
      ? 'Shim removed. The real provider binary was not changed.\n'
      : 'No shim removed.\n',
  );
};

export const shimStatusCommand = async (providerId: string, io: ShimCommandIo): Promise<void> => {
  const inspection = await inspectShim({
    providerId,
    dataDirectory: getAgentForemanPlatformPaths().dataDirectory,
  });
  if (inspection.status === 'not-installed') {
    io.write(`${providerId}: NOT INSTALLED\n`);
    return;
  }
  if (inspection.status === 'modified') {
    io.write(`${providerId}: MODIFIED (${inspection.modifiedFiles.join(', ')})\n`);
    return;
  }
  io.write(`${providerId}: INSTALLED\n`);
  io.write(`Real binary: ${inspection.metadata.realBinaryPath}\n`);
  io.write(`Shim: ${inspection.metadata.files.map((file) => file.path).join(', ')}\n`);
};

export const printShellSetupCommand = (
  shell: ShellSetupTarget | undefined,
  io: ShimCommandIo,
): void => {
  const shimDirectory = path.join(getAgentForemanPlatformPaths().dataDirectory, 'bin');
  io.write(`${renderShellSetup(shimDirectory, shell ?? detectShell())}\n`);
};

const detectShell = (): ShellSetupTarget => {
  if (process.platform === 'win32') return 'powershell';
  const shellName = path.basename(process.env.SHELL ?? 'bash');
  if (shellName === 'zsh' || shellName === 'fish') return shellName;
  return 'bash';
};
