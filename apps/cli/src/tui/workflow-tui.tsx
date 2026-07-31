import React, {useState, useSyncExternalStore} from 'react';
import {Box, Text, render, useInput, type Instance} from 'ink';

import type {RequirementDiscoveryResult, TaskPlan, TaskSession} from '@agent-foreman/contracts';
import type {WorkspaceDiff} from '@agent-foreman/workspace';

import {parsePlanInput, type PlanInputDecision} from '../workflow/plan-input.js';
import {renderTaskPlanMarkdown} from '../workflow/render-plan.js';
import type {ApplyReviewDecision, RealWorkflowInteraction} from '../workflow/run-real-workflow.js';

type PendingKind = 'idle' | 'requirements' | 'plan' | 'apply';

export interface WorkflowTuiOptions {
  readonly projectRoot: string;
  readonly supervisor: string;
  readonly worker: string;
  readonly profile: string;
  readonly noColor: boolean;
  readonly screenReader: boolean;
  readonly abort: () => void;
}

interface WorkflowTuiSnapshot {
  readonly state: string;
  readonly planVersion?: number;
  readonly iteration: number;
  readonly gateStatus: string;
  readonly providerActivity: string;
  readonly tokenUsage: string;
  readonly pending: PendingKind;
  readonly prompt: string;
  readonly conversation: readonly string[];
  readonly overlay?: string;
  readonly error?: string;
}

type WorkflowTuiChanges = {
  readonly [Key in keyof WorkflowTuiSnapshot]?: WorkflowTuiSnapshot[Key] | undefined;
};

const idleSnapshot: WorkflowTuiSnapshot = {
  state: 'Starting',
  iteration: 0,
  gateStatus: 'Not run',
  providerActivity: 'Probing providers',
  tokenUsage: 'Not reported',
  pending: 'idle',
  prompt: '',
  conversation: [],
};

export class InkWorkflowController implements RealWorkflowInteraction {
  private snapshot: WorkflowTuiSnapshot = idleSnapshot;
  private readonly listeners = new Set<() => void>();
  private requirementResolve: ((value: string | undefined) => void) | undefined;
  private planResolve: ((value: PlanInputDecision) => void) | undefined;
  private applyResolve: ((value: ApplyReviewDecision) => void) | undefined;
  private currentPlan: TaskPlan | undefined;
  private currentDiff: WorkspaceDiff | undefined;
  private cancelRequestedAt: number | undefined;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): WorkflowTuiSnapshot => this.snapshot;

  public async answerRequirements(
    discovery: RequirementDiscoveryResult,
  ): Promise<string | undefined> {
    this.update({
      pending: 'requirements',
      prompt: 'Answer the questions, or /cancel',
      conversation: [
        ...this.snapshot.conversation,
        `Objective: ${discovery.summary}`,
        ...discovery.repositoryObservations.map((value) => `Repository: ${value}`),
        ...discovery.questions.map((value, index) => `Q${String(index + 1)}: ${value}`),
        ...discovery.proposedAssumptions.map((value) => `Default: ${value}`),
      ],
    });
    return await new Promise<string | undefined>((resolve) => {
      this.requirementResolve = resolve;
    });
  }

  public async reviewPlan(plan: TaskPlan): Promise<PlanInputDecision> {
    this.currentPlan = plan;
    this.update({
      pending: 'plan',
      planVersion: plan.version,
      prompt: '/approve · /change <message> · /discuss <message> · /cancel',
      overlay: renderTaskPlanMarkdown(plan),
    });
    return await new Promise<PlanInputDecision>((resolve) => {
      this.planResolve = resolve;
    });
  }

  public async reviewApply(
    _session: TaskSession,
    diff: WorkspaceDiff,
  ): Promise<ApplyReviewDecision> {
    this.currentDiff = diff;
    this.update({
      pending: 'apply',
      prompt: '/apply · /diff · /keep · /discard · /cancel',
      overlay: `Technically approved: ${String(diff.changedFiles.length)} files, +${String(diff.additions)}/-${String(diff.deletions)}`,
    });
    return await new Promise<ApplyReviewDecision>((resolve) => {
      this.applyResolve = resolve;
    });
  }

  public notify(event: string, details?: Readonly<Record<string, unknown>>): void {
    if (event === 'state.changed') {
      const state = typeof details?.next === 'string' ? details.next : this.snapshot.state;
      const iteration =
        state === 'EXECUTING_WORKER' || state === 'REPAIRING_MECHANICAL_FAILURES'
          ? this.snapshot.iteration + 1
          : this.snapshot.iteration;
      this.update({state, iteration});
      return;
    }
    if (event === 'provider.started') {
      this.update({providerActivity: 'Provider running'});
      return;
    }
    if (event === 'provider.completed') {
      const usage = details?.tokenUsage;
      let tokenUsage = this.snapshot.tokenUsage;
      if (typeof usage === 'object' && usage !== null) {
        const inputTokens = (usage as {inputTokens?: unknown}).inputTokens;
        const outputTokens = (usage as {outputTokens?: unknown}).outputTokens;
        tokenUsage = `input ${typeof inputTokens === 'number' ? String(inputTokens) : '?'} / output ${typeof outputTokens === 'number' ? String(outputTokens) : '?'}`;
      }
      this.update({providerActivity: 'Provider completed', tokenUsage});
      return;
    }
    if (event === 'quality_gate.started') this.update({gateStatus: 'Running'});
    if (event === 'quality_gate.completed') {
      this.update({gateStatus: typeof details?.status === 'string' ? details.status : 'Completed'});
    }
  }

  public submit(raw: string): void {
    const input = raw.trim();
    this.update({error: undefined});
    if (this.snapshot.pending === 'requirements') {
      const resolve = this.requirementResolve;
      if (resolve === undefined) return;
      this.requirementResolve = undefined;
      this.update({
        pending: 'idle',
        prompt: '',
        conversation: [...this.snapshot.conversation, `You: ${input}`],
      });
      resolve(input === '/cancel' ? undefined : input);
      return;
    }
    if (this.snapshot.pending === 'plan') {
      try {
        const decision = parsePlanInput(input);
        if (decision.kind === 'show-plan') {
          this.update({
            overlay:
              this.currentPlan === undefined
                ? 'No plan.'
                : renderTaskPlanMarkdown(this.currentPlan),
          });
          return;
        }
        if (decision.kind === 'show-json') {
          this.update({overlay: JSON.stringify(this.currentPlan, null, 2)});
          return;
        }
        const resolve = this.planResolve;
        if (resolve === undefined) return;
        this.planResolve = undefined;
        this.update({pending: 'idle', prompt: '', overlay: undefined});
        resolve(
          decision.kind === 'discussion'
            ? {kind: 'request-change', message: `Discussion: ${decision.message}`}
            : decision,
        );
      } catch (error: unknown) {
        this.update({error: error instanceof Error ? error.message : 'Invalid plan command.'});
      }
      return;
    }
    if (this.snapshot.pending === 'apply') {
      if (input === '/diff') {
        this.update({overlay: this.currentDiff?.patch ?? 'No diff.'});
        return;
      }
      const decisions: Readonly<Record<string, ApplyReviewDecision>> = {
        '/apply': 'apply',
        '/keep': 'keep',
        '/discard': 'discard',
        '/cancel': 'cancel',
      };
      const decision = decisions[input];
      if (decision === undefined) {
        this.update({error: 'An explicit /apply, /keep, /discard, or /cancel is required.'});
        return;
      }
      const resolve = this.applyResolve;
      if (resolve === undefined) return;
      this.applyResolve = undefined;
      this.update({pending: 'idle', prompt: '', overlay: undefined});
      resolve(decision);
    }
  }

  public shortcut(name: 'plan' | 'diff' | 'gates' | 'logs' | 'resume' | 'cancel'): boolean {
    if (name === 'plan')
      this.update({
        overlay:
          this.currentPlan === undefined
            ? 'No plan yet.'
            : renderTaskPlanMarkdown(this.currentPlan),
      });
    if (name === 'diff') this.update({overlay: this.currentDiff?.patch ?? 'No diff yet.'});
    if (name === 'gates') this.update({overlay: `Quality gates: ${this.snapshot.gateStatus}`});
    if (name === 'logs')
      this.update({
        overlay: this.snapshot.conversation.slice(-20).join('\n') || 'No conversation log yet.',
      });
    if (name === 'resume')
      this.update({
        overlay: 'Resume is available through `af task resume <id>` for persisted tasks.',
      });
    if (name === 'cancel') {
      const now = Date.now();
      if (this.cancelRequestedAt === undefined || now - this.cancelRequestedAt > 3_000) {
        this.cancelRequestedAt = now;
        this.update({overlay: 'Press Ctrl+C again within 3 seconds to pause or cancel safely.'});
        return false;
      }
      this.cancelRequestedAt = undefined;
      if (this.snapshot.pending === 'plan') this.submit('/cancel');
      else if (this.snapshot.pending === 'apply') this.submit('/cancel');
      else if (this.snapshot.pending === 'requirements') this.submit('/cancel');
      return true;
    }
    return false;
  }

  private update(changes: WorkflowTuiChanges): void {
    const compact = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    );
    this.snapshot = {...this.snapshot, ...compact};
    if ('overlay' in changes && changes.overlay === undefined) {
      const next = {...this.snapshot};
      delete next.overlay;
      this.snapshot = next;
    }
    if ('error' in changes && changes.error === undefined) {
      const next = {...this.snapshot};
      delete next.error;
      this.snapshot = next;
    }
    for (const listener of this.listeners) listener();
  }
}

const WorkflowTui = ({
  controller,
  options,
}: {
  readonly controller: InkWorkflowController;
  readonly options: WorkflowTuiOptions;
}): React.ReactElement => {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [input, setInput] = useState('');
  useInput((character, key) => {
    if (key.ctrl) {
      const shortcut = character.toLowerCase();
      if (shortcut === 'c') {
        if (controller.shortcut('cancel')) options.abort();
      }
      if (shortcut === 'p') controller.shortcut('plan');
      if (shortcut === 'd') controller.shortcut('diff');
      if (shortcut === 'g') controller.shortcut('gates');
      if (shortcut === 'l') controller.shortcut('logs');
      if (shortcut === 'r') controller.shortcut('resume');
      return;
    }
    if (key.return) {
      controller.submit(input);
      setInput('');
      return;
    }
    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (!key.escape && character !== '') setInput((value) => `${value}${character}`);
  });

  const color = options.noColor ? undefined : 'cyan';
  return (
    <Box flexDirection="column" paddingX={1} aria-label="Agent Foreman workflow">
      <Text bold {...(color === undefined ? {} : {color})}>
        Agent Foreman
      </Text>
      <Text>Project: {options.projectRoot}</Text>
      <Text>Supervisor: {options.supervisor}</Text>
      <Text>Worker: {options.worker}</Text>
      <Text>Profile: {options.profile}</Text>
      <Text>
        State: {snapshot.state} · Plan: {snapshot.planVersion ?? '—'} · Iteration:{' '}
        {snapshot.iteration}
      </Text>
      <Text>
        Providers: {snapshot.providerActivity} · Gates: {snapshot.gateStatus} · Tokens:{' '}
        {snapshot.tokenUsage}
      </Text>
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="round"
        paddingX={1}
        aria-label="Conversation"
      >
        <Text bold>Conversation</Text>
        {snapshot.conversation.slice(-8).map((line, index) => (
          <Text key={`${String(index)}-${line}`}>{line}</Text>
        ))}
        {snapshot.conversation.length === 0 ? <Text dimColor>No conversation yet.</Text> : null}
      </Box>
      {snapshot.overlay === undefined ? null : (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          paddingX={1}
          aria-label="Details"
        >
          <Text>{snapshot.overlay.split('\n').slice(0, 24).join('\n')}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text>{snapshot.prompt}</Text>
        <Text>&gt; {input}</Text>
        {snapshot.error === undefined ? null : <Text color="red">{snapshot.error}</Text>}
      </Box>
      <Text dimColor>
        Ctrl+P plan · Ctrl+D diff · Ctrl+G gates · Ctrl+L logs · Ctrl+R resume · Ctrl+C pause/cancel
      </Text>
    </Box>
  );
};

export interface InkWorkflowHandle {
  readonly interaction: InkWorkflowController;
  dispose(): void;
}

export const createInkWorkflowInteraction = (options: WorkflowTuiOptions): InkWorkflowHandle => {
  const controller = new InkWorkflowController();
  const instance: Instance = render(<WorkflowTui controller={controller} options={options} />, {
    exitOnCtrlC: false,
    isScreenReaderEnabled: options.screenReader,
    incrementalRendering: !options.screenReader,
  });
  return {
    interaction: controller,
    dispose: () => {
      instance.unmount();
    },
  };
};
