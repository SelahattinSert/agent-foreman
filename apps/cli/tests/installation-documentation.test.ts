import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, test} from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

const unsafeRegistryInstall =
  /^(?:\$\s+)?(?:npm\s+(?:install|i)|pnpm\s+(?:add|install))\s+(?:-g|--global)\s+agent-foreman\s*$/mu;

describe('installation documentation', () => {
  test('uses the source-built tarball instead of an unrelated registry package', async () => {
    const rootReadme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const packageReadme = await readFile(
      path.join(repositoryRoot, 'apps', 'cli', 'README.md'),
      'utf8',
    );

    expect(rootReadme).not.toMatch(unsafeRegistryInstall);
    expect(packageReadme).not.toMatch(unsafeRegistryInstall);
    expect(rootReadme).toContain('npx pnpm@11.18.0 package:cli');
    expect(rootReadme).toContain('release/agent-foreman.tgz');
    expect(rootReadme).toContain('### Linux and macOS (Bash or Zsh)');
    expect(rootReadme).toContain('### Windows PowerShell');
    expect(rootReadme).toContain('### Windows Command Prompt');
  });

  test('connects the documented package command to the cross-platform packager', async () => {
    const packageManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as {scripts?: Record<string, string>};

    expect(packageManifest.scripts?.['package:cli']).toBe('node scripts/package-cli.mjs');
    await expect(
      access(path.join(repositoryRoot, 'scripts', 'package-cli.mjs')),
    ).resolves.toBeUndefined();
  });
});
