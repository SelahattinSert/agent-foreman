import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {z} from 'zod';

import {runProcess} from '@agent-foreman/process';

export const WorkerCliProbeResultSchema = z.strictObject({
  binary: z.string().min(1),
  version: z.string().min(1),
  probedAt: z.iso.datetime({offset: true}),
  printMode: z.boolean(),
  promptFlag: z.enum(['--print', '--prompt']).optional(),
  jsonOutput: z.boolean(),
  jsonSchema: z.boolean(),
  modelSelection: z.boolean(),
  workspaceMode: z.boolean(),
  sandbox: z.boolean(),
  sessionResume: z.boolean(),
  modelDiscovery: z.boolean(),
  effort: z.boolean(),
  printTimeout: z.boolean(),
  newProject: z.boolean(),
  disableSlashCommands: z.boolean(),
  logFile: z.boolean(),
});

export type WorkerCliProbeResult = z.infer<typeof WorkerCliProbeResultSchema>;

export interface ProbeWorkerCliInput {
  readonly binary: string;
  readonly cachePath?: string;
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

export const probeWorkerCli = async (input: ProbeWorkerCliInput): Promise<WorkerCliProbeResult> => {
  const now = input.now?.() ?? new Date();
  if (input.cachePath !== undefined) {
    try {
      const cached = WorkerCliProbeResultSchema.parse(
        JSON.parse(await readFile(input.cachePath, 'utf8')),
      );
      const age = now.getTime() - new Date(cached.probedAt).getTime();
      if (cached.binary === input.binary && age >= 0 && age <= (input.cacheTtlMs ?? 86_400_000)) {
        return cached;
      }
    } catch {
      // A missing or stale cache is safely replaced by a fresh capability probe.
    }
  }
  const [version, help, modelsHelp] = await Promise.all([
    runProcess({executable: input.binary, args: ['--version'], stdio: 'capture'}),
    runProcess({executable: input.binary, args: ['--help'], stdio: 'capture'}),
    runProcess({executable: input.binary, args: ['models', '--help'], stdio: 'capture'}),
  ]);
  const output = `${help.stdout}\n${help.stderr}`;
  const result = WorkerCliProbeResultSchema.parse({
    binary: input.binary,
    version: (version.stdout || version.stderr).trim(),
    probedAt: now.toISOString(),
    printMode: help.exitCode === 0 && (output.includes('--print') || output.includes('--prompt')),
    promptFlag: output.includes('--print')
      ? '--print'
      : output.includes('--prompt')
        ? '--prompt'
        : undefined,
    jsonOutput: output.includes('--output-format') && output.includes('json'),
    jsonSchema: output.includes('--json-schema'),
    modelSelection: output.includes('--model'),
    workspaceMode: output.includes('accept-edits') || output.includes('--mode'),
    sandbox: output.includes('--sandbox'),
    sessionResume: output.includes('--conversation'),
    modelDiscovery: modelsHelp.exitCode === 0,
    effort: output.includes('--effort'),
    printTimeout: output.includes('--print-timeout'),
    newProject: output.includes('--new-project'),
    disableSlashCommands: output.includes('--disable-slash-commands'),
    logFile: output.includes('--log-file'),
  });
  if (input.cachePath !== undefined) {
    await mkdir(path.dirname(input.cachePath), {recursive: true, mode: 0o700});
    await writeFile(input.cachePath, `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
  }
  return result;
};
