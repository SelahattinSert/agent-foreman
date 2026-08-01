import {createHash, randomUUID} from 'node:crypto';
import {access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';

import {z} from 'zod';

import {ConfigurationError} from '@agent-foreman/core';
import {runProcess, type ProcessRunInput, type ProcessRunResult} from '@agent-foreman/process';

const integrationName = 'agent-foreman';
const markerName = '.agent-foreman-managed.json';

const ManagedSkillMarkerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: z.literal('agent-foreman'),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export interface SetupCodexIntegrationInput {
  readonly codexHome: string;
  readonly skillSourceDirectory: string;
  readonly nodeExecutable: string;
  readonly cliEntrypoint: string;
  readonly codexBinary: string;
  readonly replaceMcp?: boolean;
  readonly run?: (input: ProcessRunInput) => Promise<ProcessRunResult>;
}

export interface SetupCodexIntegrationResult {
  readonly skillChanged: boolean;
  readonly mcpChanged: boolean;
}

interface SkillInstallationPlan {
  readonly destination: string;
  readonly contentHash: string;
  readonly changed: boolean;
  readonly replacing: boolean;
}

interface McpConfiguration {
  readonly command: string;
  readonly args: readonly string[];
}

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const hashSkillDirectory = async (
  directory: string,
  ignoredRootEntries: ReadonlySet<string> = new Set(),
): Promise<string> => {
  const hash = createHash('sha256');
  const visit = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relative === '' && ignoredRootEntries.has(entry.name)) continue;
      const childRelative = path.join(relative, entry.name);
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ConfigurationError('The packaged Agent Foreman skill may not contain symlinks.', {
          diagnostics: {path: childRelative},
        });
      }
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        hash.update(childRelative, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(await readFile(child));
        hash.update('\0', 'utf8');
      } else {
        throw new ConfigurationError(
          'The packaged Agent Foreman skill contains an unsupported entry.',
          {
            diagnostics: {path: childRelative},
          },
        );
      }
    }
  };
  await visit(directory, '');
  return hash.digest('hex');
};

const inspectSkillInstallation = async (
  codexHome: string,
  source: string,
): Promise<SkillInstallationPlan> => {
  await access(path.join(source, 'SKILL.md'));
  await access(path.join(source, 'agents', 'openai.yaml'));
  const contentHash = await hashSkillDirectory(source);
  const destination = path.join(path.resolve(codexHome), 'skills', integrationName);
  if (!(await pathExists(destination))) {
    return {destination, contentHash, changed: true, replacing: false};
  }
  const markerPath = path.join(destination, markerName);
  let marker: z.infer<typeof ManagedSkillMarkerSchema>;
  try {
    marker = ManagedSkillMarkerSchema.parse(JSON.parse(await readFile(markerPath, 'utf8')));
  } catch (cause: unknown) {
    throw new ConfigurationError(
      `Refusing to overwrite the unmanaged Codex skill at ${destination}.`,
      {cause, diagnostics: {destination}},
    );
  }
  return {
    destination,
    contentHash,
    changed: marker.contentHash !== contentHash,
    replacing: true,
  };
};

const installSkill = async (source: string, plan: SkillInstallationPlan): Promise<void> => {
  if (!plan.changed) return;
  const parent = path.dirname(plan.destination);
  await mkdir(parent, {recursive: true, mode: 0o700});
  const suffix = randomUUID();
  const staged = path.join(parent, `.agent-foreman-stage-${suffix}`);
  const backup = path.join(parent, `.agent-foreman-backup-${suffix}`);
  await cp(source, staged, {recursive: true, errorOnExist: true, force: false});
  await writeFile(
    path.join(staged, markerName),
    `${JSON.stringify({
      schemaVersion: 1,
      owner: 'agent-foreman',
      contentHash: plan.contentHash,
    })}\n`,
    {encoding: 'utf8', flag: 'wx', mode: 0o600},
  );
  try {
    if (!plan.replacing) {
      await rename(staged, plan.destination);
      return;
    }
    await rename(plan.destination, backup);
    try {
      await rename(staged, plan.destination);
    } catch (cause: unknown) {
      await rename(backup, plan.destination);
      throw cause;
    }
    await rm(backup, {recursive: true});
  } finally {
    if (await pathExists(staged)) await rm(staged, {recursive: true});
  }
};

const readMcpConfiguration = (stdout: string): McpConfiguration => {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (cause: unknown) {
    throw new ConfigurationError('Codex returned malformed MCP configuration JSON.', {cause});
  }
  if (typeof value !== 'object' || value === null) {
    throw new ConfigurationError('Codex returned an invalid MCP configuration.');
  }
  const root = value as Record<string, unknown>;
  const transportValue = root.transport;
  const transport =
    typeof transportValue === 'object' && transportValue !== null
      ? (transportValue as Record<string, unknown>)
      : root;
  const command = transport.command;
  const args = transport.args;
  if (
    typeof command !== 'string' ||
    !Array.isArray(args) ||
    !args.every((argument) => typeof argument === 'string')
  ) {
    throw new ConfigurationError('Codex MCP configuration is not a supported stdio command.');
  }
  return {command, args};
};

const assertProcessPassed = (result: ProcessRunResult, operation: string): void => {
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new ConfigurationError(`Codex MCP ${operation} failed.`, {
      diagnostics: {exitCode: result.exitCode, timedOut: result.timedOut, aborted: result.aborted},
    });
  }
};

export const setupCodexIntegration = async (
  input: SetupCodexIntegrationInput,
): Promise<SetupCodexIntegrationResult> => {
  const run = input.run ?? runProcess;
  const expected: McpConfiguration = {
    command: path.resolve(input.nodeExecutable),
    args: [path.resolve(input.cliEntrypoint), 'mcp', 'serve'],
  };
  const skillPlan = await inspectSkillInstallation(
    input.codexHome,
    path.resolve(input.skillSourceDirectory),
  );
  const getResult = await run({
    executable: input.codexBinary,
    args: ['mcp', 'get', integrationName, '--json'],
    stdio: 'capture',
    timeoutMs: 30_000,
  });
  const missing = getResult.exitCode !== 0 && /No MCP server named/iu.test(getResult.stderr);
  let mcpChanged = missing;
  if (!missing) {
    assertProcessPassed(getResult, 'inspection');
    const existing = readMcpConfiguration(getResult.stdout);
    const matches =
      existing.command === expected.command &&
      existing.args.length === expected.args.length &&
      existing.args.every((argument, index) => argument === expected.args[index]);
    if (!matches && input.replaceMcp !== true) {
      throw new ConfigurationError(
        'A different Codex MCP server named agent-foreman already exists; use --replace only after reviewing it.',
      );
    }
    mcpChanged = !matches;
    if (!matches) {
      const removed = await run({
        executable: input.codexBinary,
        args: ['mcp', 'remove', integrationName],
        stdio: 'capture',
        timeoutMs: 30_000,
      });
      assertProcessPassed(removed, 'removal');
    }
  }
  if (mcpChanged) {
    const added = await run({
      executable: input.codexBinary,
      args: ['mcp', 'add', integrationName, '--', expected.command, ...expected.args],
      stdio: 'capture',
      timeoutMs: 30_000,
    });
    assertProcessPassed(added, 'registration');
  }
  await installSkill(path.resolve(input.skillSourceDirectory), skillPlan);
  return {skillChanged: skillPlan.changed, mcpChanged};
};

export const removeCodexIntegration = async (
  input: Omit<SetupCodexIntegrationInput, 'skillSourceDirectory' | 'replaceMcp'>,
): Promise<SetupCodexIntegrationResult> => {
  const run = input.run ?? runProcess;
  const expected: McpConfiguration = {
    command: path.resolve(input.nodeExecutable),
    args: [path.resolve(input.cliEntrypoint), 'mcp', 'serve'],
  };
  const destination = path.join(path.resolve(input.codexHome), 'skills', integrationName);
  let skillChanged = false;
  if (await pathExists(destination)) {
    let marker: z.infer<typeof ManagedSkillMarkerSchema>;
    try {
      marker = ManagedSkillMarkerSchema.parse(
        JSON.parse(await readFile(path.join(destination, markerName), 'utf8')),
      );
    } catch (cause: unknown) {
      throw new ConfigurationError(
        `Refusing to remove the unmanaged Codex skill at ${destination}.`,
        {cause, diagnostics: {destination}},
      );
    }
    const installedHash = await hashSkillDirectory(destination, new Set([markerName]));
    if (installedHash !== marker.contentHash) {
      throw new ConfigurationError(
        `Refusing to remove the modified Codex skill at ${destination}.`,
        {diagnostics: {destination}},
      );
    }
    skillChanged = true;
  }

  const getResult = await run({
    executable: input.codexBinary,
    args: ['mcp', 'get', integrationName, '--json'],
    stdio: 'capture',
    timeoutMs: 30_000,
  });
  const mcpMissing = getResult.exitCode !== 0 && /No MCP server named/iu.test(getResult.stderr);
  if (!mcpMissing) {
    assertProcessPassed(getResult, 'inspection');
    const existing = readMcpConfiguration(getResult.stdout);
    const matches =
      existing.command === expected.command &&
      existing.args.length === expected.args.length &&
      existing.args.every((argument, index) => argument === expected.args[index]);
    if (!matches) {
      throw new ConfigurationError(
        'Refusing to remove a different Codex MCP server named agent-foreman.',
      );
    }
  }

  if (!mcpMissing) {
    const removed = await run({
      executable: input.codexBinary,
      args: ['mcp', 'remove', integrationName],
      stdio: 'capture',
      timeoutMs: 30_000,
    });
    assertProcessPassed(removed, 'removal');
  }
  if (skillChanged) await rm(destination, {recursive: true});
  return {skillChanged, mcpChanged: !mcpMissing};
};

export interface SetupCodexCommandOptions {
  readonly yes?: boolean;
  readonly replace?: boolean;
  readonly remove?: boolean;
}

export interface SetupCodexCommandIo {
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

const packagedSkillDirectory = async (): Promise<string> => {
  const candidate = fileURLToPath(new URL('./skills/agent-foreman', import.meta.url));
  await access(path.join(candidate, 'SKILL.md'));
  return candidate;
};

export const setupCodexCommand = async (
  options: SetupCodexCommandOptions,
  io: SetupCodexCommandIo,
): Promise<void> => {
  const cliEntrypoint = process.argv[1];
  if (cliEntrypoint === undefined) {
    throw new ConfigurationError('Cannot determine the installed Agent Foreman entrypoint.');
  }
  const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const destination = path.join(codexHome, 'skills', integrationName);
  const removing = options.remove === true;
  io.write(
    [
      `Skill: ${removing ? 'remove' : 'install'} ${destination}`,
      `MCP: ${removing ? 'remove' : 'register'} codex -> ${process.execPath} ${path.resolve(cliEntrypoint)} mcp serve`,
      'Normal Codex sessions remain unchanged; activation is explicit with $agent-foreman.',
      'No shim or PATH change is required.',
      '',
    ].join('\n'),
  );
  const approved =
    options.yes === true ||
    (await (io.confirm ?? confirmInTerminal)(
      `${removing ? 'Remove' : 'Install'} the Agent Foreman Codex integration?`,
    ));
  if (!approved) throw new ConfigurationError('Codex integration change was not approved.');
  if (removing) {
    const result = await removeCodexIntegration({
      codexHome,
      nodeExecutable: process.execPath,
      cliEntrypoint: path.resolve(cliEntrypoint),
      codexBinary: 'codex',
    });
    io.write(result.skillChanged ? 'Codex skill removed.\n' : 'Codex skill was not installed.\n');
    io.write(
      result.mcpChanged ? 'Codex MCP server removed.\n' : 'Codex MCP server was not registered.\n',
    );
    return;
  }
  const result = await setupCodexIntegration({
    codexHome,
    skillSourceDirectory: await packagedSkillDirectory(),
    nodeExecutable: process.execPath,
    cliEntrypoint: path.resolve(cliEntrypoint),
    codexBinary: 'codex',
    replaceMcp: options.replace === true,
  });
  io.write(result.skillChanged ? 'Codex skill installed.\n' : 'Codex skill already up to date.\n');
  io.write(
    result.mcpChanged ? 'Codex MCP server registered.\n' : 'Codex MCP server already configured.\n',
  );
  io.write('Restart Codex, then invoke `$agent-foreman <task>`.\n');
};
