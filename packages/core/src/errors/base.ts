export interface AgentForemanErrorOptions {
  readonly cause?: unknown;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
}

export abstract class AgentForemanError extends Error {
  public readonly code: string;
  public readonly diagnostics: Readonly<Record<string, unknown>>;
  public readonly retryable: boolean;
  public readonly userMessage: string;

  protected constructor(code: string, userMessage: string, options: AgentForemanErrorOptions = {}) {
    super(userMessage, options.cause === undefined ? undefined : {cause: options.cause});
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = options.retryable ?? false;
    this.diagnostics = options.diagnostics ?? {};
  }
}
