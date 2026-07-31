import {ShimRecursionError} from '@agent-foreman/core';

export const DISPATCH_DEPTH_VARIABLE = 'AGENT_FOREMAN_DISPATCH_DEPTH';

export interface DispatchInput {
  readonly args: readonly string[];
  readonly frontendProvider: string;
  readonly realBinaryPath: string;
  readonly dispatchDepth: number;
}

export type DispatchDecision =
  | {
      readonly kind: 'agent-foreman';
      readonly frontendProvider: string;
      readonly args: readonly string[];
    }
  | {
      readonly kind: 'passthrough';
      readonly executable: string;
      readonly args: readonly string[];
      readonly environment: Readonly<Record<typeof DISPATCH_DEPTH_VARIABLE, string>>;
    };

export const decideDispatch = (input: DispatchInput): DispatchDecision => {
  if (!Number.isSafeInteger(input.dispatchDepth) || input.dispatchDepth < 0) {
    throw new ShimRecursionError('Shim dispatch depth is invalid.', {
      diagnostics: {dispatchDepth: input.dispatchDepth},
    });
  }
  if (input.dispatchDepth > 1) {
    throw new ShimRecursionError('Shim recursion depth exceeded the safe limit.', {
      diagnostics: {dispatchDepth: input.dispatchDepth},
    });
  }

  const [firstArgument, ...remainingArguments] = input.args;
  if (firstArgument === 'agent-foreman') {
    return {
      kind: 'agent-foreman',
      frontendProvider: input.frontendProvider,
      args: remainingArguments,
    };
  }

  return {
    kind: 'passthrough',
    executable: input.realBinaryPath,
    args: input.args,
    environment: {[DISPATCH_DEPTH_VARIABLE]: String(input.dispatchDepth + 1)},
  };
};

export const parseDispatchDepth = (rawValue: string | undefined): number => {
  if (rawValue === undefined || rawValue === '') return 0;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ShimRecursionError('Shim dispatch depth environment value is invalid.');
  }
  return value;
};
