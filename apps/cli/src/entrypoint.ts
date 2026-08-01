import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const isMainModule = (moduleUrl: string, entryPoint: string | undefined): boolean => {
  if (entryPoint === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPoint);
  } catch {
    return false;
  }
};
