import {access, readFile} from 'node:fs/promises';
import path from 'node:path';

import {QualityGateError} from '@agent-foreman/core';

import type {QualityGateDefinition, QualityGateType} from './result.js';

interface PackageDocument {
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const packageManagerFor = async (root: string, document: PackageDocument): Promise<string> => {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if ((await exists(path.join(root, 'bun.lock'))) || (await exists(path.join(root, 'bun.lockb')))) {
    return 'bun';
  }
  if (await exists(path.join(root, 'package-lock.json'))) return 'npm';
  const configured = document.packageManager?.split('@', 1)[0];
  return configured === 'pnpm' || configured === 'yarn' || configured === 'bun'
    ? configured
    : 'npm';
};

const knownScripts: readonly {readonly name: string; readonly type: QualityGateType}[] = [
  {name: 'test', type: 'test'},
  {name: 'lint', type: 'lint'},
  {name: 'typecheck', type: 'typecheck'},
  {name: 'build', type: 'build'},
  {name: 'format:check', type: 'format-check'},
  {name: 'format-check', type: 'format-check'},
];

export const discoverQualityGates = async (
  projectRoot: string,
): Promise<readonly QualityGateDefinition[]> => {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!(await exists(packagePath))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packagePath, 'utf8')) as unknown;
  } catch (cause: unknown) {
    throw new QualityGateError('Project package.json could not be parsed for gate discovery.', {
      cause,
      diagnostics: {packagePath},
    });
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const document = parsed as PackageDocument;
  if (typeof document.scripts !== 'object') {
    return [];
  }
  const packageManager = await packageManagerFor(projectRoot, document);
  const gates: QualityGateDefinition[] = [];
  const seen = new Set<string>();
  for (const candidate of knownScripts) {
    if (seen.has(candidate.type) || typeof document.scripts[candidate.name] !== 'string') continue;
    seen.add(candidate.type);
    gates.push({
      id: candidate.name,
      type: candidate.type,
      command:
        packageManager === 'pnpm'
          ? [packageManager, candidate.name]
          : [packageManager, 'run', candidate.name],
      required: true,
      timeoutMs: candidate.type === 'test' || candidate.type === 'build' ? 600_000 : 300_000,
    });
  }
  return gates;
};
