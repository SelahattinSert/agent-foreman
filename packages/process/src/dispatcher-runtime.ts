import {decideDispatch, type DispatchInput} from './dispatcher.js';

export interface PassthroughInvocation {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
}

export interface DispatcherRuntimeDependencies {
  readonly runAgentForeman: (frontendProvider: string, args: readonly string[]) => Promise<number>;
  readonly runPassthrough: (invocation: PassthroughInvocation) => Promise<number>;
}

export const dispatchProviderInvocation = async (
  input: DispatchInput,
  dependencies: DispatcherRuntimeDependencies,
): Promise<number> => {
  const decision = decideDispatch(input);
  if (decision.kind === 'agent-foreman') {
    return await dependencies.runAgentForeman(decision.frontendProvider, decision.args);
  }
  return await dependencies.runPassthrough({
    executable: decision.executable,
    args: decision.args,
    environment: decision.environment,
  });
};
