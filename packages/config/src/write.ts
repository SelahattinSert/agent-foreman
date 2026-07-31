import {chmod, mkdir, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {stringify} from 'smol-toml';

import {ConfigDocumentSchema, type ConfigDocument} from './schema.js';

const snakeCaseKey = (key: string): string =>
  key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

const normalizeTomlKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeTomlKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [snakeCaseKey(key), normalizeTomlKeys(item)]),
  );
};

export const saveConfigDocument = async (
  filePath: string,
  rawDocument: ConfigDocument,
): Promise<void> => {
  const document = ConfigDocumentSchema.parse(rawDocument);
  const target = path.resolve(filePath);
  await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  const temporary = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  const content = `${stringify(normalizeTomlKeys(document))}\n`;
  await writeFile(temporary, content, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  await rename(temporary, target);
  await chmod(target, 0o600);
};
