import type {Interface} from 'node:readline/promises';

import type {RequirementDiscoveryResult, TaskPlan, TaskSession} from '@agent-foreman/contracts';
import type {WorkspaceDiff} from '@agent-foreman/workspace';

import {parsePlanInput} from './plan-input.js';
import {renderTaskPlanMarkdown} from './render-plan.js';
import type {ApplyReviewDecision, RealWorkflowInteraction} from './run-real-workflow.js';

export interface PlainInteractionOptions {
  readonly terminal: Interface;
  readonly write: (message: string) => void;
  readonly json: boolean;
}

export class PlainWorkflowInteraction implements RealWorkflowInteraction {
  public constructor(private readonly options: PlainInteractionOptions) {}

  public async answerRequirements(
    discovery: RequirementDiscoveryResult,
  ): Promise<string | undefined> {
    if (this.options.json) {
      this.options.write(
        `${JSON.stringify({event: 'requirements.questions', timestamp: new Date().toISOString(), discovery})}\n`,
      );
    } else {
      this.options.write(
        [
          '\nUnderstood objective',
          discovery.summary,
          '\nRepository observations',
          ...(discovery.repositoryObservations.length === 0
            ? ['- No additional observations.']
            : discovery.repositoryObservations.map((value) => `- ${value}`)),
          '\nDecisions to clarify',
          ...discovery.questions.map((value, index) => `${String(index + 1)}. ${value}`),
          '\nSuggested defaults',
          ...(discovery.proposedAssumptions.length === 0
            ? ['- None.']
            : discovery.proposedAssumptions.map((value) => `- ${value}`)),
          '',
        ].join('\n'),
      );
    }
    const answer = (await this.options.terminal.question('Answer (/cancel to stop): ')).trim();
    return answer === '/cancel' ? undefined : answer;
  }

  public async reviewPlan(plan: TaskPlan): Promise<ReturnType<typeof parsePlanInput>> {
    this.options.write(
      this.options.json
        ? `${JSON.stringify({event: 'plan.review', timestamp: new Date().toISOString(), plan})}\n`
        : `\n${renderTaskPlanMarkdown(plan)}\n`,
    );
    for (;;) {
      const raw = await this.options.terminal.question(
        'Plan action (/approve, /change <message>, /discuss <message>, /show-plan, /show-json, /cancel): ',
      );
      const decision = parsePlanInput(raw);
      if (decision.kind === 'show-plan') {
        this.options.write(
          this.options.json
            ? `${JSON.stringify({event: 'plan.markdown', markdown: renderTaskPlanMarkdown(plan)})}\n`
            : `\n${renderTaskPlanMarkdown(plan)}\n`,
        );
        continue;
      }
      if (decision.kind === 'show-json') {
        this.options.write(
          `${JSON.stringify(this.options.json ? {event: 'plan.json', plan} : plan, null, this.options.json ? undefined : 2)}\n`,
        );
        continue;
      }
      if (decision.kind === 'discussion') {
        if (decision.message.trim() === '') {
          this.options.write('Discussion text cannot be empty.\n');
          continue;
        }
        return {kind: 'request-change', message: `Discussion: ${decision.message}`};
      }
      return decision;
    }
  }

  public async reviewApply(
    _session: TaskSession,
    diff: WorkspaceDiff,
  ): Promise<ApplyReviewDecision> {
    this.options.write(
      this.options.json
        ? `${JSON.stringify({event: 'apply.review', timestamp: new Date().toISOString(), summary: {changedFiles: diff.changedFiles.length, additions: diff.additions, deletions: diff.deletions, hash: diff.hash}})}\n`
        : `\nTechnically approved diff: ${String(diff.changedFiles.length)} files, +${String(diff.additions)}/-${String(diff.deletions)}.\n`,
    );
    for (;;) {
      const answer = (
        await this.options.terminal.question(
          'Apply action (/diff, /apply, /keep, /discard, /cancel): ',
        )
      ).trim();
      if (answer === '/diff') {
        this.options.write(
          this.options.json
            ? `${JSON.stringify({event: 'diff.full', patch: diff.patch})}\n`
            : `${diff.patch}\n`,
        );
        continue;
      }
      if (answer === '/apply') return 'apply';
      if (answer === '/keep') return 'keep';
      if (answer === '/discard') return 'discard';
      if (answer === '/cancel') return 'cancel';
      this.options.write(
        this.options.json
          ? `${JSON.stringify({event: 'input.invalid', message: 'An explicit apply decision is required.'})}\n`
          : 'An explicit /apply, /keep, /discard, or /cancel command is required.\n',
      );
    }
  }

  public notify(event: string, details?: Readonly<Record<string, unknown>>): void {
    if (this.options.json) {
      this.options.write(
        `${JSON.stringify({event, timestamp: new Date().toISOString(), details})}\n`,
      );
      return;
    }
    if (event === 'state.changed') {
      const nextState = typeof details?.next === 'string' ? details.next : 'unknown';
      this.options.write(`State: ${nextState}\n`);
    }
  }
}
