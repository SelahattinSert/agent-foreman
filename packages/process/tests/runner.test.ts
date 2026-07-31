import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {runProcess} from '../src/index.js';

const writeNodeFixture = async (source: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-foreman-runner-'));
  const fixturePath = path.join(directory, 'fixture.mjs');
  await writeFile(fixturePath, source, {mode: 0o700});
  return fixturePath;
};

describe('runProcess', () => {
  test('captures stdout, stderr, and the exact exit code', async () => {
    const fixture = await writeNodeFixture(
      "const fs = await import('node:fs'); fs.writeSync(1, 'out'); fs.writeSync(2, 'err'); process.exitCode = 23;",
    );

    const result = await runProcess({
      executable: process.execPath,
      args: [fixture],
      stdio: 'capture',
    });

    expect(result).toMatchObject({exitCode: 23, stdout: 'out', stderr: 'err', timedOut: false});
  });

  test('passes arguments without shell interpolation', async () => {
    const fixture = await writeNodeFixture(
      "const fs = await import('node:fs'); fs.writeSync(1, JSON.stringify(process.argv.slice(2)));",
    );
    const markerDirectory = await mkdtemp(path.join(tmpdir(), 'agent-foreman-injection-'));
    const marker = path.join(markerDirectory, 'should-not-exist');
    const hostileArgument = `$(touch ${marker})`;

    const result = await runProcess({
      executable: process.execPath,
      args: [fixture, hostileArgument, 'space preserved'],
      stdio: 'capture',
    });

    expect(JSON.parse(result.stdout)).toEqual([hostileArgument, 'space preserved']);
    await expect(readFile(marker)).rejects.toMatchObject({code: 'ENOENT'});
  });

  test('writes provided stdin without adding bytes', async () => {
    const fixture = await writeNodeFixture(
      "const fs = await import('node:fs'); fs.writeSync(1, fs.readFileSync(0));",
    );

    const result = await runProcess({
      executable: process.execPath,
      args: [fixture],
      stdin: 'exact\ninput',
      stdio: 'capture',
    });

    expect(result.stdout).toBe('exact\ninput');
  });

  test('terminates a process after its timeout', async () => {
    const fixture = await writeNodeFixture('setInterval(() => undefined, 1_000);');

    const result = await runProcess({
      executable: process.execPath,
      args: [fixture],
      stdio: 'capture',
      timeoutMs: 50,
      terminationGraceMs: 25,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test('honors an AbortSignal', async () => {
    const fixture = await writeNodeFixture('setInterval(() => undefined, 1_000);');
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort('test cancellation');
    }, 30);

    const result = await runProcess({
      executable: process.execPath,
      args: [fixture],
      signal: controller.signal,
      stdio: 'capture',
      terminationGraceMs: 25,
    });

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test('can run with an explicit environment instead of forwarding secrets', async () => {
    const fixture = await writeNodeFixture(
      "const fs = await import('node:fs'); fs.writeSync(1, JSON.stringify({secret: process.env.AF_TEST_SECRET, safe: process.env.AF_SAFE_VALUE}));",
    );
    process.env.AF_TEST_SECRET = 'must-not-forward';
    try {
      const result = await runProcess({
        executable: process.execPath,
        args: [fixture],
        environment: {AF_SAFE_VALUE: 'forwarded'},
        inheritEnvironment: false,
        stdio: 'capture',
      });
      expect(JSON.parse(result.stdout)).toEqual({safe: 'forwarded'});
    } finally {
      delete process.env.AF_TEST_SECRET;
    }
  });
});
