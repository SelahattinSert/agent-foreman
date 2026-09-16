import {describe, expect, test} from 'vitest';

import {sameProjectRoot} from '../src/project-root.js';

describe('project root identity', () => {
  test('matches Windows roots without regard to casing or separator style', () => {
    expect(sameProjectRoot('C:\\Users\\Runner\\Project', 'c:/users/runner/project', 'win32')).toBe(
      true,
    );
  });

  test('matches Windows extended-length paths to regular paths', () => {
    expect(
      sameProjectRoot('\\\\?\\C:\\Users\\Runner\\Project', 'C:\\Users\\Runner\\Project', 'win32'),
    ).toBe(true);
    expect(
      sameProjectRoot('\\\\?\\UNC\\server\\share\\Project', '\\\\server\\share\\project', 'win32'),
    ).toBe(true);
  });

  test('does not match different Windows roots', () => {
    expect(
      sameProjectRoot('C:\\Users\\Runner\\Project', 'D:\\Users\\Runner\\Project', 'win32'),
    ).toBe(false);
  });

  test('keeps POSIX path comparison case-sensitive', () => {
    expect(sameProjectRoot('/tmp/project', '/tmp/project/.', 'linux')).toBe(true);
    expect(sameProjectRoot('/tmp/Project', '/tmp/project', 'linux')).toBe(false);
  });
});
