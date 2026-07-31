import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, test} from 'vitest';

import {discoverQualityGates, evaluateDiffPolicyGates, runQualityGates} from '../src/index.js';

describe('quality gates', () => {
  test('discovers deterministic Node project scripts as argument arrays', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-gates-'));
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({scripts: {test: 'vitest run', lint: 'eslint .', build: 'tsc'}}),
    );

    await expect(discoverQualityGates(root)).resolves.toEqual([
      expect.objectContaining({id: 'test', type: 'test', command: ['pnpm', 'test']}),
      expect.objectContaining({id: 'lint', type: 'lint', command: ['pnpm', 'lint']}),
      expect.objectContaining({id: 'build', type: 'build', command: ['pnpm', 'build']}),
    ]);
  });

  test('runs real commands, redacts output, and fingerprints mechanical failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-gates-'));
    const passing = path.join(root, 'pass.mjs');
    const failing = path.join(root, 'fail.mjs');
    await writeFile(passing, "const fs = await import('node:fs'); fs.writeSync(1, 'passed');");
    await writeFile(
      failing,
      "const fs = await import('node:fs'); fs.writeSync(2, 'Authorization: Bearer super-secret'); process.exitCode = 2;",
    );
    const timestamps = ['2026-07-31T10:00:00.000Z', '2026-07-31T10:01:00.000Z'];

    const report = await runQualityGates({
      workspacePath: root,
      gates: [
        {id: 'pass', type: 'test', command: [process.execPath, passing], required: true},
        {id: 'fail', type: 'lint', command: [process.execPath, failing], required: true},
      ],
      now: () => timestamps.shift() ?? '2026-07-31T10:01:00.000Z',
    });

    expect(report.status).toBe('FAILED');
    expect(report.runs?.map((run) => run.status)).toEqual(['PASSED', 'FAILED']);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.stderr).toContain('[REDACTED]');
    expect(report.failures[0]?.stderr).not.toContain('super-secret');
    expect(report.failures[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('marks timeout as a failed required gate', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-foreman-gates-'));
    const slow = path.join(root, 'slow.mjs');
    await writeFile(slow, 'setInterval(() => undefined, 1_000);');

    const report = await runQualityGates({
      workspacePath: root,
      gates: [
        {
          id: 'slow',
          type: 'test',
          command: [process.execPath, slow],
          required: true,
          timeoutMs: 50,
        },
      ],
    });

    expect(report.status).toBe('FAILED');
    expect(report.runs?.at(0)).toMatchObject({status: 'FAILED', timedOut: true});
  });
});

describe('deterministic diff policy gates', () => {
  test('detects secret-like additions, out-of-scope files, and excessive changes', () => {
    const report = evaluateDiffPolicyGates({
      patch: '+const token = "sk-test_abcdefghijklmnopqrstuvwxyz";\n',
      changedFiles: [
        {path: 'src/allowed.ts', changeType: 'modified'},
        {path: 'infra/outside.ts', changeType: 'added'},
      ],
      allowedAreas: ['src'],
      maximumChangedFiles: 1,
      maximumDiffLines: 100,
      now: () => '2026-07-31T12:00:00.000Z',
    });

    expect(report.status).toBe('FAILED');
    expect(report.failures.map(({gateId}) => gateId)).toEqual([
      'secret-scan',
      'scope-check',
      'changed-files-check',
    ]);
    expect(JSON.stringify(report)).not.toContain('sk-test_abcdefghijklmnopqrstuvwxyz');
  });
});
