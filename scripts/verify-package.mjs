import {access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import crossSpawn from 'cross-spawn';

import {packageCli} from './package-cli.mjs';

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-foreman-package-smoke-'));
const installPrefix = path.join(temporaryRoot, 'prefix');
const smokeHome = path.join(temporaryRoot, 'home');

const run = async (
  executable,
  args,
  {environment = process.env, expectedExitCode = 0, stdin} = {},
) =>
  await new Promise((resolve, reject) => {
    const child = crossSpawn(executable, args, {
      cwd: temporaryRoot,
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
  const tarballPath = await packageCli();
  await run(
    'npm',
    ['install', '--global', '--prefix', installPrefix, '--no-audit', '--no-fund', tarballPath],
    {
      environment: {
        ...process.env,
        npm_config_cache: path.join(temporaryRoot, 'npm-cache'),
      },
    },
  );

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

  // Exercise the shipped native entrypoint over real stdio, not an in-memory
  // server or imports from the checkout. No provider account is used here.
  const configDirectory =
    process.platform === 'win32'
      ? path.join(isolatedEnvironment.APPDATA, 'Agent Foreman')
      : process.platform === 'darwin'
        ? path.join(smokeHome, 'Library', 'Application Support', 'Agent Foreman')
        : path.join(isolatedEnvironment.XDG_CONFIG_HOME, 'agent-foreman');
  await mkdir(configDirectory, {recursive: true});
  await writeFile(
    path.join(configDirectory, 'config.toml'),
    [
      'version = 1',
      'active_profile = "package-smoke"',
      '[profiles.package-smoke.supervisor]',
      'provider = "codex-cli"',
      '[profiles.package-smoke.worker]',
      'provider = "antigravity-cli"',
      'model = "smoke-test-never-invoke"',
    ].join('\n'),
  );
  const installedRequire = createRequire(path.join(installedPackage, 'package.json'));
  const {Client} = await import(
    pathToFileURL(installedRequire.resolve('@modelcontextprotocol/sdk/client/index.js'))
  );
  const {StdioClientTransport} = await import(
    pathToFileURL(installedRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
  );
  const openMcp = async () => {
    const client = new Client({name: 'package-smoke', version: '1.0.0'}, {capabilities: {}});
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.join(installedPackage, 'dist', 'main.js'), 'mcp', 'serve'],
          cwd: temporaryRoot,
          env: Object.fromEntries(
            Object.entries(isolatedEnvironment).filter(([, value]) => value !== undefined),
          ),
          stderr: 'inherit',
        }),
      );
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  };
  const client = await openMcp();
  let sessionId;
  try {
    const created = await client.callTool({
      name: 'agent_foreman_session_create',
      arguments: {
        projectRoot: await realpath(temporaryRoot),
        frontendProvider: 'codex-native',
        profileName: 'package-smoke',
        task: 'Validate installed MCP without launching any provider.',
      },
    });
    if (created.isError || typeof created.structuredContent?.id !== 'string') {
      throw new Error(`Installed MCP session creation failed: ${JSON.stringify(created)}`);
    }
    sessionId = created.structuredContent.id;
    const denied = await client.callTool({
      name: 'agent_foreman_worker_start',
      arguments: {
        sessionId,
        approvedPlanHash: '0'.repeat(64),
      },
    });
    if (!denied.isError || !JSON.stringify(denied).includes('approved plan')) {
      throw new Error('Installed MCP did not reject unapproved worker execution.');
    }
  } finally {
    await client.close();
  }

  const restarted = await openMcp();
  try {
    const resumed = await restarted.callTool({
      name: 'agent_foreman_resume',
      arguments: {sessionId},
    });
    if (
      resumed.isError ||
      resumed.structuredContent?.session?.id !== sessionId ||
      resumed.structuredContent?.session?.state !== 'DISCOVERING_REPOSITORY' ||
      resumed.structuredContent?.nextAction !== 'CONTINUE_PLANNING'
    ) {
      throw new Error(
        `Installed MCP did not restore its SQLite session after restart: ${JSON.stringify(resumed)}`,
      );
    }
  } finally {
    await restarted.close();
  }

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
