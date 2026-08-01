import {realpath} from 'node:fs/promises';
import path from 'node:path';

export const canonicalPath = async (value: string): Promise<string> =>
  await realpath(path.resolve(value));
