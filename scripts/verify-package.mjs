import {access, chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import crossSpawn from 'cross-spawn';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-foreman-package-smoke-'));
const installPrefix = path.join(temporaryRoot, 'prefix');
const tarballPath = path.join(temporaryRoot, 'agent-foreman.tgz');
const smokeHome = path.join(temporaryRoot, 'home');
const pnpmEntrypoint = path.join(repositoryRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');

const run = async (
  executable,
  args,
  {environment = process.env, expectedExitCode = 0, stdin} = {},
) =>
  await new Promise((resolve, reject) => {
    const child = crossSpawn(executable, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    if (stdin === undefined) child.stdin?.end();
    else child.stdin?.end(stdin);
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (exitCode !== expectedExitCode) {
        reject(
          new Error(
            [
              `${executable} ${args.join(' ')} failed with exit code ${String(exitCode)}${signal === null ? '' : ` (${signal})`}.`,
              stdout,
              stderr,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        );
        return;
      }
      resolve({stdout, stderr});
    });
  });

try {
  await run(process.execPath, [
    pnpmEntrypoint,
    '--filter',
    'agent-foreman',
    'pack',
    '--out',
    tarballPath,
  ]);
  await run('npm', [
    'install',
    '--global',
    '--prefix',
    installPrefix,
    '--no-audit',
    '--no-fund',
    tarballPath,
  ]);

  const afCommand =
    process.platform === 'win32'
      ? path.join(installPrefix, 'af.cmd')
      : path.join(installPrefix, 'bin', 'af');
  const installedPackage =
    process.platform === 'win32'
      ? path.join(installPrefix, 'node_modules', 'agent-foreman')
      : path.join(installPrefix, 'lib', 'node_modules', 'agent-foreman');
  await access(afCommand);
  await access(path.join(installedPackage, 'dist', 'skills', 'agent-foreman', 'SKILL.md'));

  const isolatedEnvironment = {
    ...process.env,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    APPDATA: path.join(temporaryRoot, 'appdata'),
    LOCALAPPDATA: path.join(temporaryRoot, 'localappdata'),
    XDG_CONFIG_HOME: path.join(temporaryRoot, 'config'),
    XDG_DATA_HOME: path.join(temporaryRoot, 'data'),
    XDG_STATE_HOME: path.join(temporaryRoot, 'state'),
  };
  const version = await run(afCommand, ['version'], {environment: isolatedEnvironment});
  if (!version.stdout.includes('Agent Foreman 0.1.0')) {
    throw new Error(`Packaged af version output was unexpected: ${version.stdout}`);
  }
  const help = await run(afCommand, ['--help'], {environment: isolatedEnvironment});
  if (!help.stdout.includes('Agent Foreman supervisor-worker orchestration')) {
    throw new Error('Packaged af help output is missing its product description.');
  }
  await run(afCommand, ['task', 'list'], {environment: isolatedEnvironment});

  const providerScript = path.join(temporaryRoot, 'codex-real.mjs');
  await writeFile(
    providerScript,
    [
      '#!/usr/bin/env node',
      "const fs = await import('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      'fs.writeSync(1, JSON.stringify({args: process.argv.slice(2), input}));',
      "if (process.argv[2] === 'fail') process.exitCode = 37;",
    ].join('\n'),
    {mode: 0o755},
  );
  await chmod(providerScript, 0o755);
  const realProvider =
    process.platform === 'win32' ? path.join(temporaryRoot, 'codex-real.cmd') : providerScript;
  if (process.platform === 'win32') {
    await writeFile(
      realProvider,
      `@echo off\r\n"${process.execPath}" "${providerScript}" %*\r\nexit /b %errorlevel%\r\n`,
    );
  }
  await run(afCommand, ['install-shim', 'codex', '--binary', realProvider, '--yes'], {
    environment: isolatedEnvironment,
  });
  const managedBinDirectory =
    process.platform === 'win32'
      ? path.join(isolatedEnvironment.LOCALAPPDATA, 'Agent Foreman', 'bin')
      : process.platform === 'darwin'
        ? path.join(smokeHome, 'Library', 'Application Support', 'Agent Foreman', 'bin')
        : path.join(isolatedEnvironment.XDG_DATA_HOME, 'agent-foreman', 'bin');
  const providerShim = path.join(
    managedBinDirectory,
    process.platform === 'win32' ? 'codex.cmd' : 'codex',
  );
  await access(providerShim);
  const passthrough = await run(providerShim, ['exec', 'argument with spaces'], {
    environment: isolatedEnvironment,
    stdin: 'stdin preserved',
  });
  if (
    JSON.stringify(JSON.parse(passthrough.stdout)) !==
    JSON.stringify({args: ['exec', 'argument with spaces'], input: 'stdin preserved'})
  ) {
    throw new Error(`Packaged dispatcher changed passthrough data: ${passthrough.stdout}`);
  }
  await run(providerShim, ['fail'], {
    environment: isolatedEnvironment,
    expectedExitCode: 37,
    stdin: '',
  });
  const intercepted = await run(providerShim, ['agent-foreman', 'version'], {
    environment: isolatedEnvironment,
    stdin: '',
  });
  if (!intercepted.stdout.includes('Agent Foreman 0.1.0')) {
    throw new Error('Packaged dispatcher did not intercept the exact agent-foreman subcommand.');
  }
  await run(afCommand, ['uninstall-shim', 'codex', '--yes'], {
    environment: isolatedEnvironment,
  });
  await access(providerShim).then(
    () => {
      throw new Error('Managed dispatcher shim still exists after uninstall.');
    },
    (error) => {
      if (error?.code !== 'ENOENT') throw error;
    },
  );

  const packageManifest = JSON.parse(
    await readFile(path.join(installedPackage, 'package.json'), 'utf8'),
  );
  if (packageManifest.name !== 'agent-foreman') {
    throw new Error('Installed package manifest does not identify agent-foreman.');
  }
  process.stdout.write(`Package smoke passed on ${process.platform}/${process.arch}.\n`);
} finally {
  await rm(temporaryRoot, {recursive: true, force: true});
}
