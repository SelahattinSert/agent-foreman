import {AgentForemanError, type AgentForemanErrorOptions} from './base.js';

type ErrorConstructor = new (
  message: string,
  options?: AgentForemanErrorOptions,
) => AgentForemanError;

const defineError = (name: string, code: string): ErrorConstructor => {
  const DomainError = class extends AgentForemanError {
    public constructor(message: string, options: AgentForemanErrorOptions = {}) {
      super(code, message, options);
      this.name = name;
    }
  };
  Object.defineProperty(DomainError, 'name', {value: name});
  return DomainError;
};

export const ConfigurationError = defineError('ConfigurationError', 'AF_CONFIGURATION');
export const ProviderNotFoundError = defineError('ProviderNotFoundError', 'AF_PROVIDER_NOT_FOUND');
export const ProviderCapabilityError = defineError(
  'ProviderCapabilityError',
  'AF_PROVIDER_CAPABILITY',
);
export const ProviderAuthenticationError = defineError(
  'ProviderAuthenticationError',
  'AF_PROVIDER_AUTHENTICATION',
);
export const ProviderExecutionError = defineError(
  'ProviderExecutionError',
  'AF_PROVIDER_EXECUTION',
);
export const ProviderTimeoutError = defineError('ProviderTimeoutError', 'AF_PROVIDER_TIMEOUT');
export const ProviderOutputValidationError = defineError(
  'ProviderOutputValidationError',
  'AF_PROVIDER_OUTPUT_VALIDATION',
);
export const BinaryNotFoundError = defineError('BinaryNotFoundError', 'AF_BINARY_NOT_FOUND');
export const ProcessExecutionError = defineError('ProcessExecutionError', 'AF_PROCESS_EXECUTION');
export const PersistenceError = defineError('PersistenceError', 'AF_PERSISTENCE');
export const ShimInstallationError = defineError('ShimInstallationError', 'AF_SHIM_INSTALLATION');
export const ShimRecursionError = defineError('ShimRecursionError', 'AF_SHIM_RECURSION');
export const PlanNotApprovedError = defineError('PlanNotApprovedError', 'AF_PLAN_NOT_APPROVED');
export const PlanHashMismatchError = defineError('PlanHashMismatchError', 'AF_PLAN_HASH_MISMATCH');
export const WorkspacePreparationError = defineError(
  'WorkspacePreparationError',
  'AF_WORKSPACE_PREPARATION',
);
export const WorkspaceConflictError = defineError(
  'WorkspaceConflictError',
  'AF_WORKSPACE_CONFLICT',
);
export const QualityGateError = defineError('QualityGateError', 'AF_QUALITY_GATE');
export const LoopProtectionError = defineError('LoopProtectionError', 'AF_LOOP_PROTECTION');
export const ApplyConflictError = defineError('ApplyConflictError', 'AF_APPLY_CONFLICT');
export const PermissionDeniedError = defineError('PermissionDeniedError', 'AF_PERMISSION_DENIED');
export const TaskCancelledError = defineError('TaskCancelledError', 'AF_TASK_CANCELLED');

export class InvalidStateTransitionError extends AgentForemanError {
  public constructor(
    fromState: string,
    eventType: string,
    detail?: string,
    options: AgentForemanErrorOptions = {},
  ) {
    super(
      'AF_INVALID_STATE_TRANSITION',
      detail ?? `Event ${eventType} is not valid while the task is in ${fromState}.`,
      {
        ...options,
        diagnostics: {...options.diagnostics, eventType, fromState},
      },
    );
  }
}
