import {LoopProtectionError} from '../errors/index.js';

export interface WorkflowLoopLimits {
  readonly maxWorkerIterations: number;
  readonly maxMechanicalRepairs: number;
  readonly maxSupervisorReviews: number;
  readonly maxSameFindingOccurrences: number;
  readonly pauseOnNoProgressIterations: number;
  readonly detectDiffOscillation: boolean;
}

const exceeded = (
  message: string,
  diagnostics: Record<string, unknown>,
): InstanceType<typeof LoopProtectionError> => new LoopProtectionError(message, {diagnostics});

export class WorkflowLoopGuard {
  private workerIterations = 0;
  private mechanicalRepairs = 0;
  private supervisorReviews = 0;
  private readonly findingOccurrences = new Map<string, number>();
  private readonly diffHashes: string[] = [];
  private previousProviderResponseHash: string | undefined;
  private previousGateFailureKey: string | undefined;
  private previousOpenFindingCount: number | undefined;
  private noProgressReviews = 0;

  public constructor(private readonly limits: WorkflowLoopLimits) {}

  public recordWorkerIteration(): void {
    this.workerIterations += 1;
    if (this.workerIterations > this.limits.maxWorkerIterations) {
      throw exceeded('Maximum worker iteration budget was exceeded.', {
        workerIterations: this.workerIterations,
        maximum: this.limits.maxWorkerIterations,
      });
    }
  }

  public recordMechanicalRepair(): void {
    this.mechanicalRepairs += 1;
    if (this.mechanicalRepairs > this.limits.maxMechanicalRepairs) {
      throw exceeded('Maximum mechanical repair budget was exceeded.', {
        mechanicalRepairs: this.mechanicalRepairs,
        maximum: this.limits.maxMechanicalRepairs,
      });
    }
  }

  public recordSupervisorReview(): void {
    this.supervisorReviews += 1;
    if (this.supervisorReviews > this.limits.maxSupervisorReviews) {
      throw exceeded('Maximum supervisor review budget was exceeded.', {
        supervisorReviews: this.supervisorReviews,
        maximum: this.limits.maxSupervisorReviews,
      });
    }
  }

  public recordFindingOccurrences(ids: readonly string[]): void {
    for (const id of new Set(ids)) {
      const occurrences = (this.findingOccurrences.get(id) ?? 0) + 1;
      this.findingOccurrences.set(id, occurrences);
      if (occurrences > this.limits.maxSameFindingOccurrences) {
        throw exceeded(`Finding ${id} exceeded the permitted occurrence count.`, {
          findingId: id,
          occurrences,
          maximum: this.limits.maxSameFindingOccurrences,
        });
      }
    }
  }

  public recordDiff(hash: string): void {
    this.diffHashes.push(hash);
    if (this.diffHashes.length > 3) this.diffHashes.shift();
    if (
      this.limits.detectDiffOscillation &&
      this.diffHashes.length === 3 &&
      this.diffHashes[0] === this.diffHashes[2] &&
      this.diffHashes[0] !== this.diffHashes[1]
    ) {
      throw exceeded('Implementation diff is oscillating between two revisions.', {
        diffHashes: this.diffHashes,
      });
    }
  }

  public recordProviderResponse(hash: string): void {
    if (this.previousProviderResponseHash === hash) {
      throw exceeded('Provider produced the same response in consecutive iterations.', {
        responseHash: hash,
      });
    }
    this.previousProviderResponseHash = hash;
  }

  public recordGateFailures(fingerprints: readonly string[]): void {
    const key = [...fingerprints].sort().join('\n');
    if (key.length > 0 && key === this.previousGateFailureKey) {
      throw exceeded('The same quality gate failure repeated after repair.', {
        fingerprints: [...fingerprints].sort(),
      });
    }
    this.previousGateFailureKey = key.length === 0 ? undefined : key;
  }

  public recordReview(openFindingIds: readonly string[]): void {
    const count = new Set(openFindingIds).size;
    if (this.previousOpenFindingCount !== undefined && count >= this.previousOpenFindingCount) {
      this.noProgressReviews += 1;
    } else {
      this.noProgressReviews = 0;
    }
    this.previousOpenFindingCount = count;
    if (this.noProgressReviews >= this.limits.pauseOnNoProgressIterations) {
      throw exceeded('Supervisor reviews are not making progress on open findings.', {
        openFindingCount: count,
        noProgressReviews: this.noProgressReviews,
      });
    }
  }
}
