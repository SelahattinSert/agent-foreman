import {chmod, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {installShim, runProcess} from '../src/index.js';

const fixture = async (directory: string, name: string, source: string): Promise<string> => {
  const filePath = path.join(directory, name);
  await writeFile(filePath, source, {mode: 0o755});
  await chmod(filePath, 0o755);
  return filePath;
};

describe.runIf(process.platform !== 'win32')('installed POSIX shim', () => {
  test('preserves passthrough args/stdin/exit code and intercepts only agent-foreman', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-shim-e2e-'));
    const realBinary = await fixture(
      root,
      'codex-real.mjs',
      [
        '#!/usr/bin/env node',
        "const fs = await import('node:fs');",
        "const input = fs.readFileSync(0, 'utf8');",
        'fs.writeSync(1, JSON.stringify({args: process.argv.slice(2), input}));',
        "if (process.argv[2] === 'fail') process.exitCode = 37;",
      ].join('\n'),
    );
    const dispatcher = await fixture(
      root,
      'dispatcher.mjs',
      [
        "const fs = await import('node:fs');",
        "const {spawnSync} = await import('node:child_process');",
        "const metadataIndex = process.argv.indexOf('--metadata');",
        "const separatorIndex = process.argv.indexOf('--');",
        "const metadata = JSON.parse(fs.readFileSync(process.argv[metadataIndex + 1], 'utf8'));",
        'const args = process.argv.slice(separatorIndex + 1);',
        "if (args[0] === 'agent-foreman') {",
        '  fs.writeSync(1, JSON.stringify({intercepted: args.slice(1), provider: metadata.providerId}));',
        '} else {',
        "  const result = spawnSync(metadata.realBinaryPath, args, {stdio: 'inherit', env: process.env});",
        '  process.exitCode = result.status ?? 1;',
        '}',
      ].join('\n'),
    );
    const installed = await installShim({
      providerId: 'codex',
      binaryName: 'codex',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory: path.join(root, 'data'),
      platform: 'linux',
    });
    const shim = installed.shimPaths.at(0);
    expect(shim).toBeDefined();

    const pass = await runProcess({
      executable: shim ?? '',
      args: ['exec', 'argument with spaces'],
      stdin: 'stdin preserved',
      stdio: 'capture',
    });
    expect(pass.exitCode).toBe(0);
    expect(JSON.parse(pass.stdout)).toEqual({
      args: ['exec', 'argument with spaces'],
      input: 'stdin preserved',
    });

    const failure = await runProcess({
      executable: shim ?? '',
      args: ['fail'],
      stdin: '',
      stdio: 'capture',
    });
    expect(failure.exitCode).toBe(37);

    const intercepted = await runProcess({
      executable: shim ?? '',
      args: ['agent-foreman', '--plain'],
      stdin: '',
      stdio: 'capture',
    });
    expect(JSON.parse(intercepted.stdout)).toEqual({
      intercepted: ['--plain'],
      provider: 'codex',
    });
  });
});

describe.runIf(process.platform === 'win32')('installed Windows shims', () => {
  test('preserves arguments, stdin, and exit codes through CMD and PowerShell', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-windows-shim-e2e-'));
    const realBinary = await fixture(root, 'codex-real.exe', 'fixture identity only');
    const dispatcher = await fixture(
      root,
      'dispatcher.mjs',
      [
        "const fs = await import('node:fs');",
        "const metadataIndex = process.argv.indexOf('--metadata');",
        "const separatorIndex = process.argv.indexOf('--');",
        "const metadata = JSON.parse(fs.readFileSync(process.argv[metadataIndex + 1], 'utf8'));",
        'const args = process.argv.slice(separatorIndex + 1);',
        "const input = fs.readFileSync(0, 'utf8');",
        "if (args[0] === 'agent-foreman') {",
        '  fs.writeSync(1, JSON.stringify({intercepted: args.slice(1), provider: metadata.providerId}));',
        '} else {',
        '  fs.writeSync(1, JSON.stringify({args, input}));',
        "  if (args[0] === 'fail') process.exitCode = 37;",
        '}',
      ].join('\n'),
    );
    const installed = await installShim({
      providerId: 'codex',
      binaryName: 'codex',
      realBinaryPath: realBinary,
      dispatcherEntrypoint: dispatcher,
      nodeExecutable: process.execPath,
      dataDirectory: path.join(root, 'data'),
      platform: 'win32',
    });
    const cmdShim = installed.shimPaths.find((filePath) => filePath.endsWith('.cmd'));
    const powerShellShim = installed.shimPaths.find((filePath) => filePath.endsWith('.ps1'));
    expect(cmdShim).toBeDefined();
    expect(powerShellShim).toBeDefined();

    const pass = await runProcess({
      executable: cmdShim ?? '',
      args: ['exec', 'argument with spaces'],
      stdin: 'stdin preserved',
      stdio: 'capture',
    });
    expect(pass.exitCode).toBe(0);
    expect(JSON.parse(pass.stdout)).toEqual({
      args: ['exec', 'argument with spaces'],
      input: 'stdin preserved',
    });

    const failure = await runProcess({
      executable: cmdShim ?? '',
      args: ['fail'],
      stdin: '',
      stdio: 'capture',
    });
    expect(failure.exitCode).toBe(37);

    const intercepted = await runProcess({
      executable: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        powerShellShim ?? '',
        'agent-foreman',
        '--plain',
      ],
      stdin: '',
      stdio: 'capture',
    });
    expect(intercepted.exitCode).toBe(0);
    expect(JSON.parse(intercepted.stdout)).toEqual({
      intercepted: ['--plain'],
      provider: 'codex',
    });
  });
});
