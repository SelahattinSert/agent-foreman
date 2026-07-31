export type PlanInputDecision =
  | {readonly kind: 'approve'}
  | {readonly kind: 'request-change'; readonly message: string}
  | {readonly kind: 'discussion'; readonly message: string}
  | {readonly kind: 'cancel'}
  | {readonly kind: 'show-plan'}
  | {readonly kind: 'show-json'};

const commandWithMessage = (input: string, command: string): string | undefined => {
  if (!input.startsWith(`${command} `)) return undefined;
  const message = input.slice(command.length + 1).trim();
  if (message.length === 0) throw new Error(`${command.slice(1)} message cannot be empty.`);
  return message;
};

export const parsePlanInput = (rawInput: string): PlanInputDecision => {
  const input = rawInput.trim();
  if (input === '/approve') return {kind: 'approve'};
  if (input === '/cancel') return {kind: 'cancel'};
  if (input === '/show-plan') return {kind: 'show-plan'};
  if (input === '/show-json') return {kind: 'show-json'};
  if (input === '/change') throw new Error('A change message is required after /change.');
  if (input === '/discuss') throw new Error('A discussion message is required after /discuss.');
  const change = commandWithMessage(input, '/change');
  if (change !== undefined) return {kind: 'request-change', message: change};
  const discussion = commandWithMessage(input, '/discuss');
  if (discussion !== undefined) return {kind: 'discussion', message: discussion};
  return {kind: 'discussion', message: input};
};
