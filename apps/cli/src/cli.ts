import {Command} from 'commander';

import {ConfigurationError} from '@agent-foreman/core';

import {
  createProfileCommand,
  deleteProfileCommand,
  editProfileCommand,
  initProjectCommand,
  listProfilesCommand,
  useProfileCommand,
  type ProfileMutationOptions,
} from './commands/configuration.js';
import {doctorCommand} from './commands/doctor.js';
import {runRealCliWorkflow, type RealRunCliOptions} from './commands/real-run.js';
import {runSettingsCommand} from './commands/settings.js';
import {
  installShimCommand,
  printShellSetupCommand,
  shimStatusCommand,
  uninstallShimCommand,
} from './commands/shim.js';
import {
  providerDoctorCommand,
  providerListCommand,
  providerModelsCommand,
  taskCancelCommand,
  taskDiffCommand,
  taskListCommand,
  taskLogsCommand,
  taskResumeCommand,
  taskShowCommand,
} from './commands/status.js';

export interface CliDependencies {
  readonly frontendProvider: string;
  readonly runReal: (frontendProvider: string, options: RealRunCliOptions) => Promise<void>;
  readonly runSettings: () => Promise<void>;
  readonly resumeTask: (sessionId: string, write: (message: string) => void) => Promise<void>;
  readonly write: (message: string) => void;
}

const mergedProfileOptions = (
  program: Command,
  commandOptions: ProfileMutationOptions,
): ProfileMutationOptions => ({
  ...program.opts<ProfileMutationOptions>(),
  ...commandOptions,
});

const defaultDependencies = (frontendProvider: string): CliDependencies => ({
  frontendProvider,
  runReal: runRealCliWorkflow,
  runSettings: async () => {
    await runSettingsCommand(
      {
        interactive: process.stdin.isTTY && process.stdout.isTTY,
        projectRoot: process.cwd(),
        noColor: process.env.NO_COLOR !== undefined,
      },
      (message) => process.stdout.write(message),
    );
  },
  resumeTask: taskResumeCommand,
  write: (message) => process.stdout.write(message),
});

const addRuntimeOptions = (command: Command): Command =>
  command
    .option('--plain', 'Use the plain terminal interface', false)
    .option('--output <format>', 'Output format: human or json', 'human')
    .option('--profile <name>', 'Configuration profile')
    .option('--supervisor <provider>', 'Supervisor provider ID')
    .option('--supervisor-model <model>', 'Explicit supervisor model')
    .option('--worker <provider>', 'Worker provider ID')
    .option('--worker-model <model>', 'Explicit worker model')
    .option('--task <description>', 'Task text (otherwise prompted)')
    .option('--resume <task-id>', 'Resume a persisted task')
    .option('--no-color', 'Disable terminal colors');

const runReal = async (
  dependencies: CliDependencies,
  options: RealRunCliOptions,
): Promise<void> => {
  if (options.output !== 'human' && options.output !== 'json') {
    throw new ConfigurationError('--output must be either human or json.');
  }
  if (options.resume !== undefined) {
    await dependencies.resumeTask(options.resume, dependencies.write);
    return;
  }
  await dependencies.runReal(dependencies.frontendProvider, options);
};

const addProfileOptions = (command: Command): Command =>
  command
    .option('--supervisor <provider>', 'Supervisor provider ID')
    .option('--supervisor-model <model>', 'Explicit supervisor model')
    .option('--reasoning-effort <effort>', 'Supervisor reasoning effort')
    .option('--worker <provider>', 'Worker provider ID')
    .option('--worker-model <model>', 'Explicit worker model');

export const createCliProgram = (dependencies: CliDependencies): Command => {
  const program = new Command();
  program
    .name('af')
    .description('Agent Foreman supervisor-worker orchestration')
    .configureOutput({writeOut: dependencies.write, writeErr: dependencies.write});
  addRuntimeOptions(program).action(async (options: RealRunCliOptions) => {
    await runReal(dependencies, options);
  });

  program
    .command('version')
    .description('Show the Agent Foreman version')
    .action(() => {
      dependencies.write('Agent Foreman 0.1.0\n');
    });

  program
    .command('settings')
    .description('Configure a global profile or show redacted settings in non-interactive mode')
    .action(async () => {
      await dependencies.runSettings();
    });

  const init = addProfileOptions(
    program.command('init').description('Create or update project Agent Foreman configuration'),
  ).option('--profile <name>', 'Profile name', 'balanced');
  init.action(async (options: ProfileMutationOptions & {profile?: string}) => {
    const profile = options.profile ?? program.opts<{profile?: string}>().profile;
    await initProjectCommand(
      {
        ...mergedProfileOptions(program, options),
        ...(profile === undefined ? {} : {profile}),
      },
      dependencies.write,
    );
  });

  program
    .command('doctor')
    .description('Check runtime, providers, persistence, worktrees, and shim safety')
    .action(async () => {
      if (!(await doctorCommand(dependencies.write))) process.exitCode = 1;
    });

  const profiles = program.command('profile').description('Manage provider profiles');
  profiles.command('list').action(async () => {
    await listProfilesCommand(dependencies.write);
  });
  addProfileOptions(profiles.command('create').argument('<name>')).action(
    async (name: string, options: ProfileMutationOptions) => {
      await createProfileCommand(name, mergedProfileOptions(program, options), dependencies.write);
    },
  );
  addProfileOptions(profiles.command('edit').argument('<name>')).action(
    async (name: string, options: ProfileMutationOptions) => {
      await editProfileCommand(name, mergedProfileOptions(program, options), dependencies.write);
    },
  );
  profiles
    .command('use')
    .argument('<name>')
    .action(async (name: string) => {
      await useProfileCommand(name, dependencies.write);
    });
  profiles
    .command('delete')
    .argument('<name>')
    .action(async (name: string) => {
      await deleteProfileCommand(name, dependencies.write);
    });

  const providers = program.command('provider').description('Inspect configured providers');
  providers.command('list').action(async () => {
    await providerListCommand(dependencies.write);
  });
  providers.command('doctor').action(async () => {
    await providerDoctorCommand(dependencies.write);
  });
  providers
    .command('models')
    .argument('[role]', 'supervisor or worker', 'worker')
    .action(async (role: string) => {
      await providerModelsCommand(role, dependencies.write);
    });

  const tasks = program.command('task').description('Inspect and control persisted tasks');
  tasks.command('list').action(async () => {
    await taskListCommand(dependencies.write);
  });
  tasks
    .command('show')
    .argument('<id>')
    .action(async (id: string) => {
      await taskShowCommand(id, dependencies.write);
    });
  tasks
    .command('logs')
    .argument('<id>')
    .action(async (id: string) => {
      await taskLogsCommand(id, dependencies.write);
    });
  tasks
    .command('diff')
    .argument('<id>')
    .action(async (id: string) => {
      await taskDiffCommand(id, dependencies.write);
    });
  tasks
    .command('resume')
    .argument('<id>')
    .action(async (id: string) => {
      await taskResumeCommand(id, dependencies.write);
    });
  tasks
    .command('cancel')
    .argument('<id>')
    .action(async (id: string) => {
      await taskCancelCommand(id, dependencies.write);
    });

  const run = program.command('run').description('Run an Agent Foreman task');
  run.action(async () => {
    await runReal(dependencies, program.opts<RealRunCliOptions>());
  });

  program
    .command('install-shim')
    .description('Install a safe provider dispatcher shim')
    .argument('<provider>', 'Frontend provider, for example codex')
    .option('--binary <path-or-name>', 'Real provider binary path or command name')
    .option('--yes', 'Approve the displayed managed-file change', false)
    .action(async (provider: string, options: {binary?: string; yes: boolean}) => {
      await installShimCommand(provider, options, {write: dependencies.write});
    });

  program
    .command('uninstall-shim')
    .alias('uninstall-shims')
    .description('Remove a managed provider dispatcher shim')
    .argument('<provider>', 'Frontend provider, for example codex')
    .option('--yes', 'Approve removal of the displayed managed files', false)
    .action(async (provider: string, options: {yes: boolean}) => {
      await uninstallShimCommand(provider, options, {write: dependencies.write});
    });

  const shim = program.command('shim').description('Inspect or configure dispatcher shims');
  shim
    .command('status')
    .argument('[provider]', 'Frontend provider', 'codex')
    .action(async (provider: string) => {
      await shimStatusCommand(provider, {write: dependencies.write});
    });
  shim
    .command('print-shell-setup')
    .argument('[provider]', 'Provider label (the managed PATH is shared)', 'codex')
    .option('--shell <shell>', 'bash, zsh, fish, powershell, or cmd')
    .action((_provider: string, options: {shell?: string}) => {
      const supported = ['bash', 'zsh', 'fish', 'powershell', 'cmd'] as const;
      const selected = supported.find((value) => value === options.shell);
      if (options.shell !== undefined && selected === undefined) {
        throw new ConfigurationError(`Unsupported shell: ${options.shell}`);
      }
      printShellSetupCommand(selected, {write: dependencies.write});
    });

  return program;
};

export const runCli = async (
  args: readonly string[],
  frontendProvider = 'standalone',
): Promise<void> => {
  await createCliProgram(defaultDependencies(frontendProvider)).parseAsync([...args], {
    from: 'user',
  });
};
