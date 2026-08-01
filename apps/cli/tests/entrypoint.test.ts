import {mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {describe, expect, test} from 'vitest';

import {isMainModule} from '../src/entrypoint.js';

describe('CLI entrypoint identity', () => {
  test.runIf(process.platform !== 'win32')(
    'accepts an npm-style symlink to the real entrypoint',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-entrypoint-'));
      const target = path.join(root, 'main.js');
      const linkedEntry = path.join(root, 'af');
      await writeFile(target, '#!/usr/bin/env node\n');
      await symlink(target, linkedEntry);

      expect(isMainModule(pathToFileURL(target).href, linkedEntry)).toBe(true);
    },
  );

  test('rejects a different executable identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-entrypoint-'));
    const modulePath = path.join(root, 'main.js');
    const otherPath = path.join(root, 'other.js');
    await writeFile(modulePath, '');
    await writeFile(otherPath, '');

    expect(isMainModule(pathToFileURL(modulePath).href, otherPath)).toBe(false);
  });
});
