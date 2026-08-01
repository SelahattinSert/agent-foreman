import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {ConfigurationError} from '@agent-foreman/core';

import {
  defaultGlobalConfigPath,
  loadResolvedConfig,
  parseConfigToml,
  resolveConfig,
} from '../src/index.js';

describe('TOML configuration loading', () => {
  test('uses the target platform path semantics independently of the host OS', () => {
    expect(defaultGlobalConfigPath({HOME: '/Users/foreman'}, 'darwin')).toBe(
      '/Users/foreman/Library/Application Support/Agent Foreman/config.toml',
    );
    expect(
      defaultGlobalConfigPath({USERPROFILE: 'C:\\Users\\Foreman', APPDATA: 'C:\\Roaming'}, 'win32'),
    ).toBe('C:\\Roaming\\Agent Foreman\\config.toml');
  });

  test('normalizes documented snake_case keys and command arrays', () => {
    const config = parseConfigToml(`
      version = 1
      active_profile = "daily"

      [workflow]
      max_worker_iterations = 6

      [profiles.daily.supervisor]
      provider = "codex-cli"
      reasoning_effort = "high"

      [profiles.daily.worker]
      provider = "antigravity-cli"

      [[quality.gates]]
      id = "tests"
      type = "command"
      command = ["pnpm", "test"]
      required = true
      timeout_seconds = 600
    `);

    expect(config.activeProfile).toBe('daily');
    expect(config.workflow?.maxWorkerIterations).toBe(6);
    expect(config.profiles?.daily?.supervisor.reasoningEffort).toBe('high');
    expect(config.quality?.gates?.at(0)).toEqual({
      id: 'tests',
      type: 'command',
      command: ['pnpm', 'test'],
      required: true,
      timeoutSeconds: 600,
    });
  });

  test('loads global and project TOML with CLI precedence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-config-'));
    const globalPath = path.join(root, 'global.toml');
    const projectConfigDirectory = path.join(root, 'project', '.agent-foreman');
    await mkdir(projectConfigDirectory, {recursive: true});
    await writeFile(
      globalPath,
      `version = 1\nactive_profile = "daily"\n[profiles.daily.supervisor]\nprovider = "codex-cli"\nmodel = "global-supervisor"\n[profiles.daily.worker]\nprovider = "gemini-cli"\nmodel = "global-worker"\n`,
    );
    await writeFile(
      path.join(projectConfigDirectory, 'config.toml'),
      `version = 1\n[workflow]\nmax_worker_iterations = 4\n`,
    );

    const resolved = await loadResolvedConfig({
      projectRoot: path.join(root, 'project'),
      globalConfigPath: globalPath,
      cli: {workerProvider: 'antigravity-cli'},
    });

    expect(resolved.worker).toEqual({provider: 'antigravity-cli', model: 'global-worker'});
    expect(resolved.workflow.maxWorkerIterations).toBe(4);
  });

  test('uses real provider defaults rather than runtime fakes', () => {
    const resolved = resolveConfig({});
    expect(resolved.supervisor.provider).toBe('codex-cli');
    expect(resolved.worker.provider).toBe('gemini-cli');
  });

  test('reports invalid TOML through a typed configuration error', () => {
    expect(() => parseConfigToml('version = "wrong"', '/project/config.toml')).toThrow(
      ConfigurationError,
    );
  });
});
