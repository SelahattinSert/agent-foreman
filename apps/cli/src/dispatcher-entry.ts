import {
  dispatchProviderInvocation,
  loadShimMetadata,
  parseDispatchDepth,
  runProcess,
  type PassthroughInvocation,
  type ShimMetadata,
} from '@agent-foreman/process';

import {runCli} from './cli.js';

export interface ParsedDispatcherArguments {
  readonly metadataPath: string;
  readonly providerArguments: readonly string[];
}

export const parseDispatcherArguments = (args: readonly string[]): ParsedDispatcherArguments => {
  if (args[0] !== '--metadata' || args[1] === undefined || args[2] !== '--') {
    throw new Error('Dispatcher requires --metadata <path> -- before provider arguments.');
  }
  return {metadataPath: args[1], providerArguments: args.slice(3)};
};

export interface DispatcherEntryDependencies {
  readonly loadMetadata: (metadataPath: string) => Promise<ShimMetadata>;
  readonly runAgentForeman: (frontendProvider: string, args: readonly string[]) => Promise<number>;
  readonly runPassthrough: (invocation: PassthroughInvocation) => Promise<number>;
}

const defaultDependencies = (): DispatcherEntryDependencies => ({
  loadMetadata: loadShimMetadata,
  runAgentForeman: async (frontendProvider, args) => {
    await runCli(args, frontendProvider);
    return 0;
  },
  runPassthrough: async (invocation) => {
    const result = await runProcess({
      executable: invocation.executable,
      args: invocation.args,
      environment: invocation.environment,
      stdio: 'inherit',
      forwardSignals: true,
    });
    if (result.signal !== null && process.platform !== 'win32') {
      process.kill(process.pid, result.signal);
      return 1;
    }
    return result.exitCode ?? 1;
  },
});

export const runDispatcherEntry = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DispatcherEntryDependencies = defaultDependencies(),
): Promise<number> => {
  const parsed = parseDispatcherArguments(args);
  const metadata = await dependencies.loadMetadata(parsed.metadataPath);
  return await dispatchProviderInvocation(
    {
      args: parsed.providerArguments,
      dispatchDepth: parseDispatchDepth(environment.AGENT_FOREMAN_DISPATCH_DEPTH),
      frontendProvider: metadata.providerId,
      realBinaryPath: metadata.realBinaryPath,
    },
    dependencies,
  );
};
