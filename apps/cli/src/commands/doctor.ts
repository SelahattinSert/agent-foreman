import {mkdir, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {loadResolvedConfig} from '@agent-foreman/config';
import {SqliteWorkflowStore} from '@agent-foreman/persistence';
import {getAgentForemanPlatformPaths, inspectShim, runProcess} from '@agent-foreman/process';
import {discoverGitRepository} from '@agent-foreman/workspace';

import {createRuntimeSupervisor, createRuntimeWorker} from './runtime-providers.js';

type DoctorStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

interface DoctorCheck {
  readonly status: DoctorStatus;
  readonly name: string;
  readonly message: string;
  readonly suggestion?: string;
}

const nodeCheck = (): DoctorCheck => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const passes = major > 22 || (major === 22 && minor >= 13);
  return passes
    ? {status: 'PASS', name: 'Node.js', message: process.versions.node}
    : {
        status: 'FAIL',
        name: 'Node.js',
        message: `${process.versions.node} is unsupported.`,
        suggestion: 'Install Node.js 22.13 or a newer supported LTS.',
      };
};

const gitCheck = async (): Promise<DoctorCheck> => {
  const result = await runProcess({executable: 'git', args: ['--version'], stdio: 'capture'}).catch(
    () => undefined,
  );
  return result?.exitCode === 0
    ? {status: 'PASS', name: 'Git', message: result.stdout.trim()}
    : {
        status: 'FAIL',
        name: 'Git',
        message: 'Git executable is unavailable.',
        suggestion: 'Install Git and make it available on PATH.',
      };
};

export const doctorCommand = async (write: (message: string) => void): Promise<boolean> => {
  const checks: DoctorCheck[] = [nodeCheck(), await gitCheck()];
  const paths = getAgentForemanPlatformPaths();
  try {
    await mkdir(paths.stateDirectory, {recursive: true, mode: 0o700});
    const probePath = path.join(paths.stateDirectory, `.doctor-${String(process.pid)}`);
    await writeFile(probePath, 'ok', {mode: 0o600, flag: 'wx'});
    await unlink(probePath);
    checks.push({status: 'PASS', name: 'Data directory', message: paths.stateDirectory});
  } catch (error: unknown) {
    checks.push({
      status: 'FAIL',
      name: 'Data directory',
      message: error instanceof Error ? error.message : 'Directory is not writable.',
      suggestion: 'Correct ownership and write permissions for the Agent Foreman state directory.',
    });
  }
  try {
    const database = await SqliteWorkflowStore.open({databasePath: ':memory:'});
    database.close();
    checks.push({status: 'PASS', name: 'SQLite', message: 'Migration and access succeeded.'});
  } catch (error: unknown) {
    checks.push({
      status: 'FAIL',
      name: 'SQLite',
      message: error instanceof Error ? error.message : 'SQLite access failed.',
      suggestion: 'Reinstall agent-foreman for the current Node.js runtime.',
    });
  }

  try {
    const config = await loadResolvedConfig({projectRoot: process.cwd()});
    checks.push({
      status:
        config.supervisor.model === undefined || config.worker.model === undefined
          ? 'FAIL'
          : 'PASS',
      name: 'Active profile',
      message: `${config.activeProfile}: ${config.supervisor.provider} → ${config.worker.provider}`,
      ...(config.supervisor.model === undefined || config.worker.model === undefined
        ? {
            suggestion:
              'Configure explicit supervisor and worker models with `af profile create` or project config.',
          }
        : {}),
    });
    const [supervisor, worker] = [
      createRuntimeSupervisor(config, path.join(paths.dataDirectory, 'cache')),
      createRuntimeWorker(config, path.join(paths.dataDirectory, 'cache')),
    ];
    const [supervisorHealth, workerHealth] = await Promise.all([
      supervisor.healthCheck(),
      worker.healthCheck(),
    ]);
    checks.push({
      status: supervisorHealth.status,
      name: 'Supervisor provider',
      message: supervisorHealth.message,
      ...(supervisorHealth.status === 'FAIL'
        ? {
            suggestion:
              'Check the configured Codex binary, authentication, model, and exec JSON support.',
          }
        : {}),
    });
    checks.push({
      status: workerHealth.status,
      name: 'Worker provider',
      message: workerHealth.message,
      ...(workerHealth.status === 'FAIL'
        ? {suggestion: 'Check the worker binary, authentication, model, and headless JSON support.'}
        : {}),
    });
    await supervisor.dispose();
    await worker.dispose();
  } catch (error: unknown) {
    checks.push({
      status: 'FAIL',
      name: 'Configuration',
      message: error instanceof Error ? error.message : 'Configuration validation failed.',
      suggestion: 'Run `af settings` and correct the reported profile/provider values.',
    });
  }

  const repository = await discoverGitRepository(process.cwd());
  checks.push(
    repository.kind === 'git'
      ? {
          status: 'PASS',
          name: 'Git worktree',
          message: `Supported in ${repository.projectRoot}.`,
        }
      : {
          status: 'SKIP',
          name: 'Git worktree',
          message:
            'Current directory is not a Git repository; isolated snapshot mode is available.',
        },
  );

  const shim = await inspectShim({providerId: 'codex', dataDirectory: paths.dataDirectory});
  checks.push(
    shim.status === 'installed'
      ? {status: 'PASS', name: 'Codex shim', message: shim.metadata.files[0]?.path ?? 'installed'}
      : shim.status === 'modified'
        ? {
            status: 'FAIL',
            name: 'Codex shim',
            message: 'Managed shim files were modified.',
            suggestion: 'Inspect the files, then reinstall the shim intentionally.',
          }
        : {
            status: 'WARN',
            name: 'Codex shim',
            message: 'Not installed.',
            suggestion: 'Run `af install-shim codex` after reviewing the displayed paths.',
          },
  );
  checks.push(
    Number(process.env.AGENT_FOREMAN_DISPATCH_DEPTH ?? '0') <= 1
      ? {status: 'PASS', name: 'Shim recursion', message: 'No unsafe recursion detected.'}
      : {
          status: 'FAIL',
          name: 'Shim recursion',
          message: 'Dispatch depth is unsafe.',
          suggestion: 'Remove recursive shim directories from PATH and reopen the shell.',
        },
  );
  checks.push({
    status: 'PASS',
    name: 'Platform',
    message: `${process.platform} / ${process.env.SHELL ?? process.env.ComSpec ?? 'unknown shell'}`,
  });

  for (const check of checks) {
    write(`${check.status.padEnd(4)} ${check.name}: ${check.message}\n`);
    if (check.suggestion !== undefined) write(`     Fix: ${check.suggestion}\n`);
  }
  return !checks.some(({status}) => status === 'FAIL');
};
