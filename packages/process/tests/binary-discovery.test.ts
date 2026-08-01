import {chmod, mkdir, mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {BinaryNotFoundError} from '@agent-foreman/core';

import {discoverBinary} from '../src/index.js';

const executable = async (filePath: string): Promise<void> => {
  await writeFile(filePath, '#!/bin/sh\nexit 0\n');
  await chmod(filePath, 0o755);
};

describe('discoverBinary', () => {
  test('resolves symlink chains to an absolute real executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-discovery-'));
    const realDirectory = path.join(root, 'real');
    const pathDirectory = path.join(root, 'path');
    await mkdir(realDirectory);
    await mkdir(pathDirectory);
    const realBinary = path.join(realDirectory, 'provider-real');
    await executable(realBinary);
    await symlink(realBinary, path.join(pathDirectory, 'provider'));

    await expect(
      discoverBinary({binaryName: 'provider', pathValue: pathDirectory, platform: 'linux'}),
    ).resolves.toBe(realBinary);
  });

  test('excludes the managed shim directory while resolving the real binary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-discovery-'));
    const shimDirectory = path.join(root, 'shims');
    const realDirectory = path.join(root, 'real');
    await mkdir(shimDirectory);
    await mkdir(realDirectory);
    await executable(path.join(shimDirectory, 'codex'));
    const realBinary = path.join(realDirectory, 'codex');
    await executable(realBinary);

    await expect(
      discoverBinary({
        binaryName: 'codex',
        pathValue: [shimDirectory, realDirectory].join(path.delimiter),
        excludedDirectories: [shimDirectory],
        platform: 'linux',
      }),
    ).resolves.toBe(realBinary);
  });

  test('rejects a candidate that resolves to the current shim identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-discovery-'));
    const shim = path.join(root, 'codex');
    await executable(shim);

    await expect(
      discoverBinary({
        binaryName: 'codex',
        currentExecutablePath: shim,
        pathValue: root,
        platform: 'linux',
      }),
    ).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  test('discovers a Windows CMD provider through PATHEXT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-discovery-win32-'));
    const binary = path.join(root, 'provider.cmd');
    await writeFile(binary, '@echo off\r\nexit /b 0\r\n');

    await expect(
      discoverBinary({
        binaryName: 'provider',
        pathValue: root,
        platform: 'win32',
        pathExtensions: ['.CMD'],
      }),
    ).resolves.toBe(binary);
  });
});
