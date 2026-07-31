import type {TokenUsage} from '@agent-foreman/contracts';

export interface CodexTransportRequest {
  readonly executionId: string;
  readonly prompt: string;
  readonly outputSchema: unknown;
  readonly cwd: string;
  readonly model: string;
  readonly profile?: string;
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly environmentAllowlist: readonly string[];
}

export interface CodexTransportResponse {
  readonly value: unknown;
  readonly threadId?: string;
  readonly tokenUsage?: TokenUsage;
  readonly events: readonly unknown[];
}

export interface CodexTransport {
  start(): Promise<void>;
  request(input: CodexTransportRequest): Promise<CodexTransportResponse>;
  cancel(executionId: string): Promise<void>;
  dispose(): Promise<void>;
}
