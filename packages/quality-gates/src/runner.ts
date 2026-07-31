import {createHash} from 'node:crypto';

import {
  QualityGateReportSchema,
  type QualityGateFailure,
  type QualityGateReport,
  type QualityGateRunResult,
} from '@agent-foreman/contracts';
import {QualityGateError} from '@agent-foreman/core';
import {redactValue} from '@agent-foreman/observability';
import {runProcess} from '@agent-foreman/process';

import type {QualityGateDefinition} from './result.js';

export interface RunQualityGatesInput {
  readonly workspacePath: string;
  readonly gates: readonly QualityGateDefinition[];
  readonly signal?: AbortSignal;
  readonly environmentAllowlist?: readonly string[];
  readonly now?: () => string;
}

const defaultEnvironmentAllowlist = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'CI',
  'NO_COLOR',
] as const;

const allowedEnvironment = (names: readonly string[]): NodeJS.ProcessEnv =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const redactString = (value: string): string => {
  const redacted = redactValue(value);
  if (typeof redacted !== 'string')
    throw new QualityGateError('Output redaction returned invalid data.');
  return redacted;
};

const fingerprint = (
  gate: QualityGateDefinition,
  exitCode: number | null,
  timedOut: boolean,
  stdout: string,
  stderr: string,
): string =>
  createHash('sha256')
    .update(gate.id)
    .update('\0')
    .update(String(exitCode))
    .update('\0')
    .update(timedOut ? 'timeout' : 'completed')
    .update('\0')
    .update(stdout)
    .update('\0')
    .update(stderr)
    .digest('hex');

const failureSummary = (run: QualityGateRunResult): string => {
  if (run.timedOut) return `Gate ${run.gateId} timed out.`;
  const firstLine = (run.stderr || run.stdout).split('\n').find((line) => line.trim() !== '');
  return firstLine === undefined
    ? `Gate ${run.gateId} exited with code ${String(run.exitCode)}.`
    : firstLine.slice(0, 500);
};

export const runQualityGates = async (input: RunQualityGatesInput): Promise<QualityGateReport> => {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const runs: QualityGateRunResult[] = [];
  const failures: QualityGateFailure[] = [];
  const environment = allowedEnvironment(input.environmentAllowlist ?? defaultEnvironmentAllowlist);

  for (const gate of input.gates) {
    const [executable, ...args] = gate.command;
    if (executable.trim() === '') {
      throw new QualityGateError(`Gate ${gate.id} has no executable.`);
    }
    const result = await runProcess({
      executable,
      args,
      cwd: input.workspacePath,
      environment,
      inheritEnvironment: false,
      ...(input.signal === undefined ? {} : {signal: input.signal}),
      stdio: 'capture',
      timeoutMs: gate.timeoutMs ?? 300_000,
    });
    const stdout = redactString(result.stdout);
    const stderr = redactString(result.stderr);
    const status = result.aborted
      ? ('CANCELLED' as const)
      : result.exitCode === 0 && !result.timedOut
        ? ('PASSED' as const)
        : ('FAILED' as const);
    const runFingerprint = fingerprint(gate, result.exitCode, result.timedOut, stdout, stderr);
    const run: QualityGateRunResult = {
      gateId: gate.id,
      type: gate.type,
      status,
      required: gate.required,
      executable,
      args,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdout,
      stderr,
      fingerprint: runFingerprint,
    };
    runs.push(run);
    if (status !== 'PASSED') {
      failures.push({
        gateId: gate.id,
        type: gate.type,
        summary: failureSummary(run),
        fingerprint: runFingerprint,
        required: gate.required,
        stdout,
        stderr,
      });
    }
    if (status === 'CANCELLED') break;
  }

  const reportStatus = runs.some((run) => run.status === 'CANCELLED')
    ? ('CANCELLED' as const)
    : runs.some((run) => run.required && run.status === 'FAILED')
      ? ('FAILED' as const)
      : ('PASSED' as const);
  return QualityGateReportSchema.parse({
    status: reportStatus,
    failures,
    startedAt,
    completedAt: now(),
    runs,
  });
};
