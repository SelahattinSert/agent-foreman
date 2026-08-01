import type {ChildProcess} from 'node:child_process';

import crossSpawn from 'cross-spawn';

import {BinaryNotFoundError, ProcessExecutionError} from '@agent-foreman/core';

export type ProcessStdioMode = 'capture' | 'inherit';

export interface ProcessRunInput {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnvironment?: boolean;
  readonly stdin?: string | Uint8Array;
  readonly stdio?: ProcessStdioMode;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly forwardSignals?: boolean;
}

export interface ProcessRunResult {
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const forwardedSignals: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];

const positiveDuration = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProcessExecutionError('Process duration values must be positive integers.', {
      diagnostics: {value},
    });
  }
  return value;
};

const terminateChild = (child: ChildProcess, graceMs: number): NodeJS.Timeout | undefined => {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, graceMs);
  timer.unref();
  return timer;
};

export const runProcess = async (input: ProcessRunInput): Promise<ProcessRunResult> => {
  const startedAt = Date.now();
  const stdio = input.stdio ?? 'capture';
  const graceMs = positiveDuration(input.terminationGraceMs, 1_000);
  const timeoutMs =
    input.timeoutMs === undefined ? undefined : positiveDuration(input.timeoutMs, input.timeoutMs);

  if (input.signal?.aborted === true) {
    return {
      aborted: true,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stderr: '',
      stdout: '',
      timedOut: false,
    };
  }
  if (stdio === 'inherit' && input.stdin !== undefined) {
    throw new ProcessExecutionError('Provided stdin cannot be combined with inherited stdio.');
  }

  return await new Promise<ProcessRunResult>((resolve, reject) => {
    const child = crossSpawn(input.executable, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: {...(input.inheritEnvironment === false ? {} : process.env), ...input.environment},
      shell: false,
      stdio: stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    });

    let aborted = false;
    let timedOut = false;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let forceKillTimer: NodeJS.Timeout | undefined;

    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener('abort', abortHandler);
      for (const [signalName, handler] of signalHandlers)
        process.removeListener(signalName, handler);
    };
    const requestTermination = (): void => {
      forceKillTimer ??= terminateChild(child, graceMs);
    };
    const abortHandler = (): void => {
      aborted = true;
      requestTermination();
    };
    const timeoutTimer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            requestTermination();
          }, timeoutMs);
    timeoutTimer?.unref();

    input.signal?.addEventListener('abort', abortHandler, {once: true});
    if (input.forwardSignals === true) {
      for (const signalName of forwardedSignals) {
        const handler = (): void => {
          if (child.exitCode === null && child.signalCode === null) child.kill(signalName);
        };
        signalHandlers.set(signalName, handler);
        process.on(signalName, handler);
      }
    }

    if (stdio === 'capture') {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      if (input.stdin === undefined) {
        child.stdin?.end();
      } else {
        child.stdin?.end(input.stdin);
      }
    }

    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cause.code === 'ENOENT') {
        reject(
          new BinaryNotFoundError(`Executable was not found: ${input.executable}`, {
            cause,
            diagnostics: {executable: input.executable},
          }),
        );
        return;
      }
      reject(
        new ProcessExecutionError(`Failed to start executable: ${input.executable}`, {
          cause,
          diagnostics: {executable: input.executable},
        }),
      );
    });

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        aborted,
        durationMs: Date.now() - startedAt,
        exitCode,
        signal,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
};
