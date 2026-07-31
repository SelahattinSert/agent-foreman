import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {z} from 'zod';

import {runProcess} from '@agent-foreman/process';

const CodexProbeResultSchema = z.strictObject({
  binary: z.string().min(1),
  version: z.string().min(1),
  probedAt: z.iso.datetime({offset: true}),
  authentication: z.enum(['authenticated', 'missing', 'unknown']),
  execJson: z.boolean(),
  outputSchema: z.boolean(),
  outputLastMessage: z.boolean(),
  readOnlySandbox: z.boolean(),
  workingDirectory: z.boolean(),
  modelSelection: z.boolean(),
  skipGitRepositoryCheck: z.boolean(),
  ephemeral: z.boolean(),
  ignoreRepositoryRules: z.boolean(),
  ignoreUserConfig: z.boolean(),
  colorControl: z.boolean(),
  profileSelection: z.boolean(),
  configOverride: z.boolean(),
  appServer: z.boolean(),
});

export type CodexProbeResult = z.infer<typeof CodexProbeResultSchema>;

export interface ProbeCodexInput {
  readonly binary: string;
  readonly cachePath?: string;
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

const readCache = async (
  cachePath: string | undefined,
  binary: string,
  now: Date,
  ttlMs: number,
): Promise<CodexProbeResult | undefined> => {
  if (cachePath === undefined) return undefined;
  try {
    const cached = CodexProbeResultSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')));
    const age = now.getTime() - new Date(cached.probedAt).getTime();
    return cached.binary === binary && age >= 0 && age <= ttlMs ? cached : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof z.ZodError) {
      return undefined;
    }
    return undefined;
  }
};

export const probeCodexCli = async (input: ProbeCodexInput): Promise<CodexProbeResult> => {
  const now = input.now?.() ?? new Date();
  const cached = await readCache(
    input.cachePath,
    input.binary,
    now,
    input.cacheTtlMs ?? 86_400_000,
  );
  if (cached !== undefined) return cached;
  const [version, execHelp, appServerHelp, login] = await Promise.all([
    runProcess({executable: input.binary, args: ['--version'], stdio: 'capture'}),
    runProcess({executable: input.binary, args: ['exec', '--help'], stdio: 'capture'}),
    runProcess({executable: input.binary, args: ['app-server', '--help'], stdio: 'capture'}),
    runProcess({executable: input.binary, args: ['login', 'status'], stdio: 'capture'}),
  ]);
  const help = `${execHelp.stdout}\n${execHelp.stderr}`;
  const result = CodexProbeResultSchema.parse({
    binary: input.binary,
    version: (version.stdout || version.stderr).trim(),
    probedAt: now.toISOString(),
    authentication:
      login.exitCode === 0
        ? 'authenticated'
        : /not logged|missing|unauth/iu.test(`${login.stdout}\n${login.stderr}`)
          ? 'missing'
          : 'unknown',
    execJson: execHelp.exitCode === 0 && help.includes('--json'),
    outputSchema: help.includes('--output-schema'),
    outputLastMessage: help.includes('--output-last-message'),
    readOnlySandbox: help.includes('read-only'),
    workingDirectory: help.includes('--cd'),
    modelSelection: help.includes('--model'),
    skipGitRepositoryCheck: help.includes('--skip-git-repo-check'),
    ephemeral: help.includes('--ephemeral'),
    ignoreRepositoryRules: help.includes('--ignore-rules'),
    ignoreUserConfig: help.includes('--ignore-user-config'),
    colorControl: help.includes('--color'),
    profileSelection: help.includes('--profile'),
    configOverride: help.includes('--config') || /(?:^|\s)-c(?:,|\s)/u.test(help),
    appServer: appServerHelp.exitCode === 0,
  });
  if (input.cachePath !== undefined) {
    await mkdir(path.dirname(input.cachePath), {recursive: true, mode: 0o700});
    await writeFile(input.cachePath, `${JSON.stringify(result, null, 2)}\n`, {mode: 0o600});
  }
  return result;
};
