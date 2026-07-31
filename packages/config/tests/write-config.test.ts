import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {loadConfigDocument, saveConfigDocument} from '../src/index.js';

describe('saveConfigDocument', () => {
  test('atomically writes snake-case TOML that round-trips through validation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'af-config-write-'));
    const filePath = path.join(directory, '.agent-foreman', 'config.toml');
    await saveConfigDocument(filePath, {
      version: 1,
      activeProfile: 'daily',
      profiles: {
        daily: {
          supervisor: {provider: 'codex-cli', model: 'supervisor-model', reasoningEffort: 'high'},
          worker: {provider: 'antigravity-cli', model: 'worker-model'},
        },
      },
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('active_profile = "daily"');
    expect(raw).toContain('reasoning_effort = "high"');
    await expect(loadConfigDocument(filePath, true)).resolves.toMatchObject({
      activeProfile: 'daily',
      profiles: {daily: {worker: {provider: 'antigravity-cli'}}},
    });
  });
});
