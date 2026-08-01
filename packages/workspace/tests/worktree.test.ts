import {access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {beforeEach, describe, expect, test} from 'vitest';

import {
  ApplyConflictError,
  PermissionDeniedError,
  WorkspaceConflictError,
} from '@agent-foreman/core';
import {runProcess} from '@agent-foreman/process';

import {
  applyWorkspaceChanges,
  collectWorkspaceDiff,
  discardGitWorkspace,
  discoverGitRepository,
  prepareGitWorkspace,
} from '../src/index.js';

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await runProcess({executable: 'git', args, cwd, stdio: 'capture'});
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const createRepository = async (): Promise<{root: string; dataDirectory: string}> => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'agent-foreman-worktree-'));
  const root = path.join(fixtureRoot, 'project');
  const dataDirectory = path.join(fixtureRoot, 'data');
  await mkdir(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'fixture@example.test']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'core.eol', 'lf']);
  await writeFile(path.join(root, 'source.txt'), 'baseline\n');
  await git(root, ['add', 'source.txt']);
  await git(root, ['commit', '-m', 'baseline']);
  return {root, dataDirectory};
};

describe('Git execution workspace', () => {
  let fixture: {root: string; dataDirectory: string};

  beforeEach(async () => {
    fixture = await createRepository();
  });

  test('discovers repository identity and cleanliness', async () => {
    const discovery = await discoverGitRepository(fixture.root);
    expect(discovery).toMatchObject({
      kind: 'git',
      projectRoot: await realpath(fixture.root),
      clean: true,
    });
    expect(discovery.kind === 'git' ? discovery.headRevision : '').toMatch(/^[a-f0-9]{40}$/u);
  });

  test('creates an isolated worktree, captures tracked and untracked diff, then applies after approval', async () => {
    const workspace = await prepareGitWorkspace({
      projectRoot: fixture.root,
      taskId: 'task-001',
      dataDirectory: fixture.dataDirectory,
      dirtyStrategy: 'cancel',
    });
    await writeFile(path.join(workspace.path, 'source.txt'), 'implemented\n');
    await writeFile(path.join(workspace.path, 'new file.txt'), 'new\n');

    expect(await readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('baseline\n');
    const diff = await collectWorkspaceDiff(workspace);
    expect(diff.patch).toContain('implemented');
    expect(diff.changedFiles.map((file) => file.path)).toEqual(['new file.txt', 'source.txt']);

    await expect(
      applyWorkspaceChanges({workspace, sourceProjectRoot: fixture.root, approved: false}),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await applyWorkspaceChanges({workspace, sourceProjectRoot: fixture.root, approved: true});
    expect(await readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('implemented\n');
    expect(await readFile(path.join(fixture.root, 'new file.txt'), 'utf8')).toBe('new\n');
  });

  test('uses canonical path identities for symlinked repositories and worktree data', async () => {
    await mkdir(fixture.dataDirectory, {recursive: true});
    const fixtureRoot = path.dirname(fixture.root);
    const projectAlias = path.join(fixtureRoot, 'project-alias');
    const dataAlias = path.join(fixtureRoot, 'data-alias');
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(fixture.root, projectAlias, symlinkType);
    await symlink(fixture.dataDirectory, dataAlias, symlinkType);

    const workspace = await prepareGitWorkspace({
      projectRoot: projectAlias,
      taskId: 'task-canonical-paths',
      dataDirectory: dataAlias,
      dirtyStrategy: 'cancel',
    });

    expect(workspace.sourceProjectRoot).toBe(await realpath(fixture.root));
    expect(workspace.path).toBe(
      await realpath(path.join(fixture.dataDirectory, 'worktrees', 'task-canonical-paths')),
    );

    await writeFile(path.join(workspace.path, 'source.txt'), 'canonical aliases\n');
    await applyWorkspaceChanges({workspace, sourceProjectRoot: projectAlias, approved: true});
    expect(await readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe(
      'canonical aliases\n',
    );
    await expect(discardGitWorkspace(workspace)).resolves.toMatchObject({status: 'DISCARDED'});
  });

  test('stops without applying when the source repository changed after workspace creation', async () => {
    const workspace = await prepareGitWorkspace({
      projectRoot: fixture.root,
      taskId: 'task-002',
      dataDirectory: fixture.dataDirectory,
      dirtyStrategy: 'cancel',
    });
    await writeFile(path.join(workspace.path, 'source.txt'), 'worker change\n');
    await writeFile(path.join(fixture.root, 'source.txt'), 'concurrent user change\n');

    await expect(
      applyWorkspaceChanges({workspace, sourceProjectRoot: fixture.root, approved: true}),
    ).rejects.toBeInstanceOf(ApplyConflictError);
    expect(await readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe(
      'concurrent user change\n',
    );
  });

  test('discards only the recorded managed worktree and is idempotent', async () => {
    const workspace = await prepareGitWorkspace({
      projectRoot: fixture.root,
      taskId: 'task-discard',
      dataDirectory: fixture.dataDirectory,
      dirtyStrategy: 'cancel',
    });
    await writeFile(path.join(workspace.path, 'source.txt'), 'throw away\n');

    const discarded = await discardGitWorkspace(workspace);
    expect(discarded.status).toBe('DISCARDED');
    await expect(access(workspace.path)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(discardGitWorkspace(discarded)).resolves.toMatchObject({status: 'DISCARDED'});
    expect(await readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('baseline\n');
  });

  test('requires an explicit dirty-repository strategy and can baseline tracked changes without untracked files', async () => {
    await writeFile(path.join(fixture.root, 'source.txt'), 'user tracked change\n');
    await writeFile(path.join(fixture.root, 'untracked.txt'), 'must not copy\n');

    await expect(
      prepareGitWorkspace({
        projectRoot: fixture.root,
        taskId: 'task-003',
        dataDirectory: fixture.dataDirectory,
        dirtyStrategy: 'cancel',
      }),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);

    const workspace = await prepareGitWorkspace({
      projectRoot: fixture.root,
      taskId: 'task-003',
      dataDirectory: fixture.dataDirectory,
      dirtyStrategy: 'include-tracked',
    });
    expect(await readFile(path.join(workspace.path, 'source.txt'), 'utf8')).toBe(
      'user tracked change\n',
    );
    await expect(readFile(path.join(workspace.path, 'untracked.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeFile(path.join(workspace.path, 'source.txt'), 'worker after user baseline\n');
    await applyWorkspaceChanges({workspace, sourceProjectRoot: fixture.root, approved: true});
    expect(await readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe(
      'worker after user baseline\n',
    );
    expect(await readFile(path.join(fixture.root, 'untracked.txt'), 'utf8')).toBe(
      'must not copy\n',
    );
  });
});
