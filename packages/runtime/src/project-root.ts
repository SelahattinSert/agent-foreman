import {realpath} from 'node:fs/promises';
import path from 'node:path';

const normalizeWindowsPath = (value: string): string => {
  let normalized = path.win32.normalize(value);
  const extendedUncPrefix = '\\\\?\\UNC\\';
  if (normalized.toLowerCase().startsWith(extendedUncPrefix.toLowerCase())) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }
  return normalized.toLowerCase();
};

export const sameProjectRoot = (
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (platform === 'win32') {
    return normalizeWindowsPath(left) === normalizeWindowsPath(right);
  }
  return path.posix.normalize(left) === path.posix.normalize(right);
};

export const canonicalizeProjectRoot = async (value: string): Promise<string> =>
  await realpath(path.resolve(value));
