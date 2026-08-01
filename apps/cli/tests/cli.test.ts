import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test, vi} from 'vitest';

import {defaultGlobalConfigPath, parseConfigToml} from '@agent-foreman/config';

import {createCliProgram} from '../src/cli.js';
import {resolveWorkspaceExecutionMode} from '../src/commands/real-run.js';

describe('Agent Foreman CLI', () => {
  test('honors isolated workspace modes and rejects direct current-workspace execution', () => {
    expect(resolveWorkspaceExecutionMode('smart', 'git')).toBe('worktree');
    expect(resolveWorkspaceExecutionMode('smart', 'none')).toBe('snapshot');
    expect(resolveWorkspaceExecutionMode('snapshot', 'git')).toBe('snapshot');
    expect(() => resolveWorkspaceExecutionMode('worktree', 'none')).toThrow(/Git repository/iu);
    expect(() => resolveWorkspaceExecutionMode('current', 'git')).toThrow(/apply approval/iu);
  });

  test('routes both standalone root and run commands to real providers by default', async () => {
    const runReal = vi.fn(async () => undefined);
    const dependencies = {
      frontendProvider: 'codex',
      runReal,
      runMcp: vi.fn(() => Promise.resolve()),
      runSettings: vi.fn(() => Promise.resolve()),
      resumeTask: vi.fn(async () => undefined),
      write: vi.fn(),
    };

    await createCliProgram(dependencies).parseAsync(
      ['--plain', '--supervisor-model', 'supervisor', '--worker-model', 'worker'],
      {from: 'user'},
    );
    await createCliProgram(dependencies).parseAsync(['run', '--plain'], {from: 'user'});

    expect(runReal).toHaveBeenNthCalledWith(
      1,
      'codex',
      expect.objectContaining({
        plain: true,
        supervisorModel: 'supervisor',
        workerModel: 'worker',
      }),
    );
    expect(runReal).toHaveBeenNthCalledWith(2, 'codex', expect.objectContaining({plain: true}));
  });

  test('prints the product version without invoking a provider', async () => {
    const runReal = vi.fn(async () => undefined);
    const output: string[] = [];
    const program = createCliProgram({
      frontendProvider: 'standalone',
      runReal,
      runMcp: vi.fn(() => Promise.resolve()),
      runSettings: vi.fn(() => Promise.resolve()),
      resumeTask: vi.fn(async () => undefined),
      write: (message) => output.push(message),
    });

    await program.parseAsync(['version'], {from: 'user'});

    expect(output.join('')).toContain('Agent Foreman 0.1.0');
  });

  test('applies provider/model flags parsed at the root to profile creation', async () => {
    const configRoot = path.join(
      tmpdir(),
      `agent-foreman-cli-profile-${String(process.pid)}-${String(Date.now())}`,
    );
    vi.stubEnv('XDG_CONFIG_HOME', configRoot);
    vi.stubEnv('HOME', configRoot);
    vi.stubEnv('USERPROFILE', configRoot);
    vi.stubEnv('APPDATA', configRoot);
    const program = createCliProgram({
      frontendProvider: 'standalone',
      runReal: vi.fn(async () => undefined),
      runMcp: vi.fn(() => Promise.resolve()),
      runSettings: vi.fn(() => Promise.resolve()),
      resumeTask: vi.fn(async () => undefined),
      write: vi.fn(),
    });

    await program.parseAsync(
      [
        'profile',
        'create',
        'daily',
        '--supervisor',
        'codex-cli',
        '--supervisor-model',
        'supervisor-model',
        '--worker',
        'antigravity-cli',
        '--worker-model',
        'worker-model',
      ],
      {from: 'user'},
    );

    try {
      const config = parseConfigToml(await readFile(defaultGlobalConfigPath(), 'utf8'));
      expect(config.profiles?.daily).toMatchObject({
        supervisor: {provider: 'codex-cli', model: 'supervisor-model'},
        worker: {provider: 'antigravity-cli', model: 'worker-model'},
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('routes settings through the injected terminal-aware entry point', async () => {
    const runReal = vi.fn(() => Promise.resolve());
    const runSettings = vi.fn(() => Promise.resolve());
    const dependencies = {
      frontendProvider: 'standalone',
      runReal,
      runMcp: vi.fn(() => Promise.resolve()),
      runSettings,
      resumeTask: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
    };

    await createCliProgram(dependencies).parseAsync(['settings'], {from: 'user'});

    expect(runSettings).toHaveBeenCalledOnce();
    expect(runReal).not.toHaveBeenCalled();
  });

  test('runs the headless MCP server only through the explicit mcp serve command', async () => {
    const runMcp = vi.fn(() => Promise.resolve());
    const dependencies = {
      frontendProvider: 'standalone',
      runReal: vi.fn(() => Promise.resolve()),
      runMcp,
      runSettings: vi.fn(() => Promise.resolve()),
      resumeTask: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
    };

    await createCliProgram(dependencies).parseAsync(['mcp', 'serve'], {from: 'user'});

    expect(runMcp).toHaveBeenCalledOnce();
    expect(dependencies.runReal).not.toHaveBeenCalled();
  });
});
