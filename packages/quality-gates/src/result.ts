export type QualityGateType =
  | 'command'
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'format-check'
  | 'secret-scan'
  | 'scope-check'
  | 'changed-files-check'
  | 'diff-size-check'
  | 'custom';

export interface QualityGateDefinition {
  readonly id: string;
  readonly type: QualityGateType;
  readonly command: readonly [string, ...string[]];
  readonly required: boolean;
  readonly timeoutMs?: number;
}
