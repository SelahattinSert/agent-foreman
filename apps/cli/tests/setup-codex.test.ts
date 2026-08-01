import {access, mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test, vi} from 'vitest';

import type {ProcessRunInput, ProcessRunResult} from '@agent-foreman/process';

import {removeCodexIntegration, setupCodexIntegration} from '../src/commands/setup-codex.js';

const processResult = (exitCode: number, stdout = '', stderr = ''): ProcessRunResult => ({
  aborted: false,
  durationMs: 1,
  exitCode,
  signal: null,
  stderr,
  stdout,
  timedOut: false,
});

const createSkillSource = async (root: string): Promise<string> => {
  const source = path.join(root, 'source-skill');
  await mkdir(path.join(source, 'agents'), {recursive: true});
  await writeFile(
    path.join(source, 'SKILL.md'),
    '---\nname: agent-foreman\ndescription: Explicit test skill.\n---\n',
  );
  await writeFile(
    path.join(source, 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n',
  );
  return source;
};

describe('Codex skill and MCP setup', () => {
  test('ships namespaced workflow commands that Codex does not intercept as slash commands', async () => {
    const skillPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../skills/agent-foreman/SKILL.md',
    );
    const skill = await readFile(skillPath, 'utf8');

    expect(skill).toContain('$agent-foreman approve');
    expect(skill).toContain('$agent-foreman change <message>');
    expect(skill).toContain('$agent-foreman apply');
    expect(skill).not.toContain('`/approve`');
    expect(skill).not.toContain('`/apply`');
  });

  test('installs a managed explicit-only skill and registers the absolute MCP command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-setup-'));
    const skillSourceDirectory = await createSkillSource(root);
    const codexHome = path.join(root, 'codex-home');
    const calls: ProcessRunInput[] = [];
    const run = vi.fn(async (input: ProcessRunInput) => {
      calls.push(input);
      return input.args?.[1] === 'get'
        ? processResult(1, '', "Error: No MCP server named 'agent-foreman' found.")
        : processResult(0);
    });

    const result = await setupCodexIntegration({
      codexHome,
      skillSourceDirectory,
      nodeExecutable: '/absolute/node',
      cliEntrypoint: '/absolute/agent-foreman/main.js',
      codexBinary: '/absolute/codex',
      run,
    });

    expect(result).toMatchObject({skillChanged: true, mcpChanged: true});
    expect(
      await readFile(path.join(codexHome, 'skills', 'agent-foreman', 'SKILL.md'), 'utf8'),
    ).toContain('name: agent-foreman');
    expect(
      await readFile(
        path.join(codexHome, 'skills', 'agent-foreman', 'agents', 'openai.yaml'),
        'utf8',
      ),
    ).toContain('allow_implicit_invocation: false');
    expect(calls.at(-1)).toMatchObject({
      executable: '/absolute/codex',
      args: [
        'mcp',
        'add',
        'agent-foreman',
        '--',
        '/absolute/node',
        '/absolute/agent-foreman/main.js',
        'mcp',
        'serve',
      ],
    });
  });

  test('is idempotent when its managed skill and MCP registration are unchanged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-setup-'));
    const skillSourceDirectory = await createSkillSource(root);
    const codexHome = path.join(root, 'codex-home');
    let installed = false;
    const run = vi.fn(async (input: ProcessRunInput) => {
      if (input.args?.[1] === 'get') {
        return installed
          ? processResult(
              0,
              JSON.stringify({
                name: 'agent-foreman',
                transport: {
                  type: 'stdio',
                  command: '/absolute/node',
                  args: ['/absolute/main.js', 'mcp', 'serve'],
                },
              }),
            )
          : processResult(1, '', "Error: No MCP server named 'agent-foreman' found.");
      }
      installed = true;
      return processResult(0);
    });
    const input = {
      codexHome,
      skillSourceDirectory,
      nodeExecutable: '/absolute/node',
      cliEntrypoint: '/absolute/main.js',
      codexBinary: '/absolute/codex',
      run,
    } as const;

    await setupCodexIntegration(input);
    const second = await setupCodexIntegration(input);

    expect(second).toEqual({skillChanged: false, mcpChanged: false});
    expect(run.mock.calls.filter(([call]) => call.args?.[1] === 'add')).toHaveLength(1);
  });

  test('refuses to overwrite an unmanaged skill', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-setup-'));
    const skillSourceDirectory = await createSkillSource(root);
    const codexHome = path.join(root, 'codex-home');
    const unmanaged = path.join(codexHome, 'skills', 'agent-foreman');
    await mkdir(unmanaged, {recursive: true});
    await writeFile(path.join(unmanaged, 'SKILL.md'), 'user-owned');

    await expect(
      setupCodexIntegration({
        codexHome,
        skillSourceDirectory,
        nodeExecutable: '/absolute/node',
        cliEntrypoint: '/absolute/main.js',
        codexBinary: '/absolute/codex',
        run: vi.fn(async () =>
          processResult(1, '', "Error: No MCP server named 'agent-foreman' found."),
        ),
      }),
    ).rejects.toThrow(/unmanaged/iu);
  });

  test('refuses to replace a different MCP registration without --replace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-setup-'));
    const skillSourceDirectory = await createSkillSource(root);
    const run = vi.fn(async () =>
      processResult(
        0,
        JSON.stringify({
          name: 'agent-foreman',
          transport: {
            type: 'stdio',
            command: '/some/other/runtime',
            args: ['serve'],
          },
        }),
      ),
    );

    await expect(
      setupCodexIntegration({
        codexHome: path.join(root, 'codex-home'),
        skillSourceDirectory,
        nodeExecutable: '/absolute/node',
        cliEntrypoint: '/absolute/main.js',
        codexBinary: '/absolute/codex',
        run,
      }),
    ).rejects.toThrow(/different.*MCP/iu);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('removes only its hash-verified managed skill and matching MCP registration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-setup-'));
    const skillSourceDirectory = await createSkillSource(root);
    const codexHome = path.join(root, 'codex-home');
    let registered = false;
    const run = vi.fn(async (input: ProcessRunInput) => {
      if (input.args?.[1] === 'get') {
        return registered
          ? processResult(
              0,
              JSON.stringify({
                transport: {
                  command: '/absolute/node',
                  args: ['/absolute/main.js', 'mcp', 'serve'],
                },
              }),
            )
          : processResult(1, '', "Error: No MCP server named 'agent-foreman' found.");
      }
      registered = input.args?.[1] === 'add';
      return processResult(0);
    });
    await setupCodexIntegration({
      codexHome,
      skillSourceDirectory,
      nodeExecutable: '/absolute/node',
      cliEntrypoint: '/absolute/main.js',
      codexBinary: '/absolute/codex',
      run,
    });

    const removed = await removeCodexIntegration({
      codexHome,
      nodeExecutable: '/absolute/node',
      cliEntrypoint: '/absolute/main.js',
      codexBinary: '/absolute/codex',
      run,
    });

    expect(removed).toEqual({skillChanged: true, mcpChanged: true});
    await expect(access(path.join(codexHome, 'skills', 'agent-foreman'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      removeCodexIntegration({
        codexHome,
        nodeExecutable: '/absolute/node',
        cliEntrypoint: '/absolute/main.js',
        codexBinary: '/absolute/codex',
        run,
      }),
    ).resolves.toEqual({skillChanged: false, mcpChanged: false});
  });
});
