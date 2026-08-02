import {copyFile, mkdir, mkdtemp, readdir, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import crossSpawn from 'cross-spawn';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpmEntrypoint = path.join(repositoryRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const defaultOutputPath = path.join(repositoryRoot, 'release', 'agent-foreman.tgz');

const runPack = async (destination) =>
  await new Promise((resolve, reject) => {
    const child = crossSpawn(
      process.execPath,
      [pnpmEntrypoint, '--filter', 'agent-foreman', 'pack', '--pack-destination', destination],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            [
              `pnpm pack failed with exit code ${String(exitCode)}${signal === null ? '' : ` (${signal})`}.`,
              stdout,
              stderr,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        );
        return;
      }
      resolve();
    });
  });

export const packageCli = async ({outputPath = defaultOutputPath} = {}) => {
  const resolvedOutputPath = path.resolve(outputPath);
  const outputDirectory = path.dirname(resolvedOutputPath);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-foreman-pack-'));
  const stagedOutput = path.join(
    outputDirectory,
    `.agent-foreman-${process.pid}-${Date.now()}.tmp`,
  );

  try {
    await runPack(temporaryRoot);
    const archives = (await readdir(temporaryRoot)).filter((entry) => entry.endsWith('.tgz'));
    if (archives.length !== 1) {
      throw new Error(
        `Expected pnpm pack to produce exactly one tarball, but found ${archives.length}.`,
      );
    }

    await mkdir(outputDirectory, {recursive: true});
    await copyFile(path.join(temporaryRoot, archives[0]), stagedOutput);
    await rename(stagedOutput, resolvedOutputPath);
    return resolvedOutputPath;
  } finally {
    await rm(stagedOutput, {force: true});
    await rm(temporaryRoot, {recursive: true, force: true});
  }
};

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const outputPath = await packageCli();
  process.stdout.write(`${outputPath}\n`);
}
