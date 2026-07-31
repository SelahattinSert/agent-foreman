import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {ApplyConflictError, PermissionDeniedError} from '@agent-foreman/core';

import {
  applyWorkspaceChanges,
  collectWorkspaceDiff,
  prepareSnapshotWorkspace,
} from '../src/index.js';

describe('non-Git snapshot workspace', () => {
  test('excludes secrets, produces a real diff, and applies only after source verification and approval', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'af-snapshot-'));
    const source = path.join(fixture, 'source');
    const data = path.join(fixture, 'data');
    await mkdir(path.join(source, 'src'), {recursive: true});
    await writeFile(path.join(source, 'src', 'value.txt'), 'baseline\n');
    await writeFile(path.join(source, '.env'), 'TOKEN=must-not-copy\n');

    const workspace = await prepareSnapshotWorkspace({
      projectRoot: source,
      taskId: 'snapshot-001',
      dataDirectory: data,
    });
    await expect(readFile(path.join(workspace.path, '.env'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await writeFile(path.join(workspace.path, 'src', 'value.txt'), 'implemented\n');
    await writeFile(path.join(workspace.path, 'src', 'new.txt'), 'new\n');

    const diff = await collectWorkspaceDiff(workspace);
    expect(diff.changedFiles.map(({path: filePath}) => filePath)).toEqual([
      'src/new.txt',
      'src/value.txt',
    ]);
    expect(diff.patch).toContain('src/value.txt');
    await expect(
      applyWorkspaceChanges({workspace, sourceProjectRoot: source, approved: false}),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const result = await applyWorkspaceChanges({
      workspace,
      sourceProjectRoot: source,
      approved: true,
    });
    expect(result.workspace.status).toBe('APPLIED');
    expect(await readFile(path.join(source, 'src', 'value.txt'), 'utf8')).toBe('implemented\n');
    expect(await readFile(path.join(source, 'src', 'new.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(path.join(source, '.env'), 'utf8')).toBe('TOKEN=must-not-copy\n');
  });

  test('detects concurrent source changes before writing any snapshot result', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'af-snapshot-conflict-'));
    const source = path.join(fixture, 'source');
    const data = path.join(fixture, 'data');
    await mkdir(source);
    await writeFile(path.join(source, 'a.txt'), 'a0\n');
    await writeFile(path.join(source, 'b.txt'), 'b0\n');
    const workspace = await prepareSnapshotWorkspace({
      projectRoot: source,
      taskId: 'snapshot-002',
      dataDirectory: data,
    });
    await writeFile(path.join(workspace.path, 'a.txt'), 'a-worker\n');
    await writeFile(path.join(workspace.path, 'b.txt'), 'b-worker\n');
    await writeFile(path.join(source, 'b.txt'), 'b-user\n');

    await expect(
      applyWorkspaceChanges({workspace, sourceProjectRoot: source, approved: true}),
    ).rejects.toBeInstanceOf(ApplyConflictError);
    expect(await readFile(path.join(source, 'a.txt'), 'utf8')).toBe('a0\n');
    expect(await readFile(path.join(source, 'b.txt'), 'utf8')).toBe('b-user\n');
  });
});
