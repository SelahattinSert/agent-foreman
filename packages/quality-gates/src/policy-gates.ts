import {createHash} from 'node:crypto';

import {
  QualityGateReportSchema,
  type ChangedFile,
  type QualityGateFailure,
  type QualityGateReport,
} from '@agent-foreman/contracts';

export interface EvaluateDiffPolicyGatesInput {
  readonly patch: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly allowedAreas: readonly string[];
  readonly maximumChangedFiles?: number;
  readonly maximumDiffLines?: number;
  readonly now?: () => string;
}

const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"'\n]{12,}["']/giu,
] as const;

const fingerprint = (id: string, evidence: string): string =>
  createHash('sha256').update(id).update('\0').update(evidence).digest('hex');

const failure = (
  gateId: string,
  type: string,
  summary: string,
  evidence: string,
): QualityGateFailure => ({
  gateId,
  type,
  summary,
  fingerprint: fingerprint(gateId, evidence),
  required: true,
  stdout: '',
  stderr: '',
});

const isAllowed = (filePath: string, allowedAreas: readonly string[]): boolean =>
  allowedAreas.length === 0 ||
  allowedAreas.some((area) => {
    const normalized = area.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
    return filePath === normalized || filePath.startsWith(`${normalized}/`);
  });

export const evaluateDiffPolicyGates = (input: EvaluateDiffPolicyGatesInput): QualityGateReport => {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const failures: QualityGateFailure[] = [];
  const addedLines = input.patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  const secretPattern = secretPatterns.find((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(addedLines);
  });
  if (secretPattern !== undefined) {
    failures.push(
      failure(
        'secret-scan',
        'secret-scan',
        'Potential secret material was added to the diff.',
        secretPattern.source,
      ),
    );
  }
  const outside = input.changedFiles
    .map(({path}) => path)
    .filter((filePath) => !isAllowed(filePath, input.allowedAreas));
  if (outside.length > 0) {
    failures.push(
      failure(
        'scope-check',
        'scope-check',
        `Changed files fall outside approved areas: ${outside.join(', ')}`,
        outside.sort().join('\n'),
      ),
    );
  }
  if (
    input.maximumChangedFiles !== undefined &&
    input.changedFiles.length > input.maximumChangedFiles
  ) {
    failures.push(
      failure(
        'changed-files-check',
        'changed-files-check',
        `Changed file count ${String(input.changedFiles.length)} exceeds ${String(input.maximumChangedFiles)}.`,
        String(input.changedFiles.length),
      ),
    );
  }
  const diffLines = input.patch === '' ? 0 : input.patch.split('\n').length;
  if (input.maximumDiffLines !== undefined && diffLines > input.maximumDiffLines) {
    failures.push(
      failure(
        'diff-size-check',
        'diff-size-check',
        `Diff line count ${String(diffLines)} exceeds ${String(input.maximumDiffLines)}.`,
        String(diffLines),
      ),
    );
  }
  return QualityGateReportSchema.parse({
    status: failures.length === 0 ? 'PASSED' : 'FAILED',
    failures,
    startedAt,
    completedAt: now(),
    runs: [],
  });
};
