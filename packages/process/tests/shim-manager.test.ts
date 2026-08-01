import {chmod, mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {ShimInstallationError} from '@agent-foreman/core';

import {installShim, inspectShim, renderShellSetup, uninstallShim} from '../src/index.js';

const createFixture = async (root: string, name: string, source: string): Promise<string> => {
  const filePath = path.join(root, name);
  await writeFile(filePath, source);
  await chmod(filePath, 0o755);
  return filePath;
};

describe('shim manager', () => {
  test('installs an idempotent shim without touching the real binary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-shim-'));
    const dataDirectory = path.join(root, 'data');
    await mkdir(dataDirectory);
    const realBinary = await createFixture(root, 'codex-real', '#!/bin/sh\nexit 0\n');
    const dispatcher = await createFixture(root, 'dispatcher.mjs', 'process.exitCode = 0;');
    const originalRealBinary = await readFile(realBinary, 'utf8');

    const first = await installShim({
      providerId: 'codex',
      binaryName: 'codex',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory,
      platform: 'linux',
    });
    const second = await installShim({
      providerId: 'codex',
      binaryName: 'codex',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory,
      platform: 'linux',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readFile(realBinary, 'utf8')).toBe(originalRealBinary);
    await expect(inspectShim({providerId: 'codex', dataDirectory})).resolves.toMatchObject({
      status: 'installed',
      metadata: {realBinaryPath: await realpath(realBinary)},
    });
  });

  test('refuses to overwrite an unrelated executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-shim-'));
    const dataDirectory = path.join(root, 'data');
    const binDirectory = path.join(dataDirectory, 'bin');
    await mkdir(binDirectory, {recursive: true});
    await createFixture(binDirectory, 'codex', '#!/bin/sh\necho unrelated\n');
    const realBinary = await createFixture(root, 'codex-real', '#!/bin/sh\nexit 0\n');
    const dispatcher = await createFixture(root, 'dispatcher.mjs', 'process.exitCode = 0;');

    await expect(
      installShim({
        providerId: 'codex',
        binaryName: 'codex',
        realBinaryPath: realBinary,
        dispatcherEntrypoint: dispatcher,
        nodeExecutable: process.execPath,
        dataDirectory,
        platform: 'linux',
      }),
    ).rejects.toBeInstanceOf(ShimInstallationError);
  });

  test('uninstall is idempotent and refuses to remove a modified shim', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-shim-'));
    const dataDirectory = path.join(root, 'data');
    const realBinary = await createFixture(root, 'codex-real', '#!/bin/sh\nexit 0\n');
    const dispatcher = await createFixture(root, 'dispatcher.mjs', 'process.exitCode = 0;');
    const installed = await installShim({
      providerId: 'codex',
      binaryName: 'codex',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory,
      platform: 'linux',
    });
    const installedShimPath = installed.shimPaths.at(0);
    expect(installedShimPath).toBeDefined();
    await writeFile(installedShimPath ?? '', '#!/bin/sh\necho changed\n');

    await expect(uninstallShim({providerId: 'codex', dataDirectory})).rejects.toBeInstanceOf(
      ShimInstallationError,
    );
    await installShim({
      providerId: 'codex',
      binaryName: 'codex-other',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory: path.join(root, 'other-data'),
      platform: 'linux',
    });
    await expect(
      uninstallShim({providerId: 'missing', dataDirectory: path.join(root, 'missing')}),
    ).resolves.toMatchObject({removed: false});
  });

  test('renders explicit PATH setup for POSIX shells and PowerShell', () => {
    expect(renderShellSetup('/managed/agent-foreman/bin', 'bash')).toContain(
      'export PATH=\'/managed/agent-foreman/bin\':"$PATH"',
    );
    expect(renderShellSetup('C:\\Agent Foreman\\bin', 'powershell')).toContain(
      "$env:PATH = 'C:\\Agent Foreman\\bin;' + $env:PATH",
    );
  });

  test('writes both CMD and PowerShell shims for Windows without touching the real binary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-windows-shim-'));
    const realBinary = await createFixture(root, 'codex-real.cmd', '@echo off\r\nexit /b 0\r\n');
    const dispatcher = await createFixture(root, 'dispatcher.mjs', 'process.exitCode = 0;');
    const originalRealBinary = await readFile(realBinary, 'utf8');

    const installed = await installShim({
      providerId: 'codex',
      binaryName: 'codex',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory: path.join(root, 'data'),
      platform: 'win32',
    });

    expect(installed.shimPaths.map((filePath) => path.extname(filePath)).sort()).toEqual([
      '.cmd',
      '.ps1',
    ]);
    expect(await readFile(realBinary, 'utf8')).toBe(originalRealBinary);
    expect(await readFile(installed.shimPaths[0] ?? '', 'utf8')).toContain('--metadata');
    expect(await readFile(installed.shimPaths[1] ?? '', 'utf8')).toContain('--metadata');
  });
});
