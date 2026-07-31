import type {Profile} from '@agent-foreman/config';
import type {ModelDescriptor} from '@agent-foreman/contracts';

import {SETTINGS_PROVIDER_CATALOG, type SettingsValidation} from './provider-catalog.js';
import {
  normalizeProfileName,
  type GlobalProfileService,
  type SettingsDraft,
} from './profile-service.js';

export type SettingsStep =
  | 'loading'
  | 'profile-choice'
  | 'profile-name'
  | 'supervisor-provider'
  | 'supervisor-model'
  | 'reasoning-effort'
  | 'worker-provider'
  | 'worker-model-choice'
  | 'worker-model'
  | 'validation'
  | 'warning-confirmation'
  | 'review'
  | 'saving'
  | 'completed'
  | 'cancelled';

export interface SettingsChoice {
  readonly id: string;
  readonly label: string;
}

export interface SettingsSnapshot {
  readonly step: SettingsStep;
  readonly title: string;
  readonly choices: readonly SettingsChoice[];
  readonly selectedIndex: number;
  readonly input: string;
  readonly draft: Readonly<Partial<SettingsDraft>>;
  readonly providerBinaries: Readonly<Record<string, string>>;
  readonly validation?: SettingsValidation;
  readonly busy: boolean;
  readonly saveEligible: boolean;
  readonly error?: string;
}

export type SettingsWizardResult =
  {readonly kind: 'saved'; readonly profileName: string} | {readonly kind: 'cancelled'};

export interface SettingsControllerDependencies {
  readonly service: Pick<GlobalProfileService, 'load' | 'save'>;
  readonly initialProfile?: string;
  readonly validate: (draft: SettingsDraft) => Promise<SettingsValidation>;
  readonly discoverWorkerModels: (
    providerId: string,
    draft: Readonly<Partial<SettingsDraft>>,
  ) => Promise<readonly ModelDescriptor[]>;
}

type SettingsSnapshotChanges = {
  readonly [Key in keyof SettingsSnapshot]?: SettingsSnapshot[Key] | undefined;
};

const initialSnapshot: SettingsSnapshot = {
  step: 'loading',
  title: 'Loading global profiles',
  choices: [],
  selectedIndex: 0,
  input: '',
  draft: {},
  providerBinaries: {},
  busy: true,
  saveEligible: false,
};

const textSteps = new Set<SettingsStep>(['profile-name', 'supervisor-model', 'worker-model']);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'The settings operation failed.';

const withoutSupervisorModel = (
  draft: Readonly<Partial<SettingsDraft>>,
): Readonly<Partial<SettingsDraft>> => {
  const {supervisorModel: _omitted, ...rest} = draft;
  return rest;
};

const withoutWorkerModel = (
  draft: Readonly<Partial<SettingsDraft>>,
): Readonly<Partial<SettingsDraft>> => {
  const {workerModel: _omitted, ...rest} = draft;
  return rest;
};

export class SettingsController {
  private snapshot: SettingsSnapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private profiles: Readonly<Record<string, Profile>> = {};
  private resultResolve: ((result: SettingsWizardResult) => void) | undefined;
  private readonly result: Promise<SettingsWizardResult>;

  public constructor(private readonly dependencies: SettingsControllerDependencies) {
    this.result = new Promise<SettingsWizardResult>((resolve) => {
      this.resultResolve = resolve;
    });
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): SettingsSnapshot => this.snapshot;

  public async initialize(): Promise<void> {
    try {
      const document = await this.dependencies.service.load();
      this.profiles = document.profiles ?? {};
      const choices: SettingsChoice[] = [
        ...Object.keys(this.profiles)
          .sort()
          .map((name) => ({id: `profile:${name}`, label: name})),
        {id: 'create-profile', label: 'Create a new global profile'},
      ];
      const activeProfile = this.dependencies.initialProfile ?? document.activeProfile;
      const providerBinaries = Object.fromEntries(
        [...SETTINGS_PROVIDER_CATALOG.supervisor, ...SETTINGS_PROVIDER_CATALOG.worker].map(
          ({id, defaultBinary}) => {
            const configured = document.providers?.[id]?.binary;
            return [id, typeof configured === 'string' ? configured : defaultBinary];
          },
        ),
      );
      const activeIndex =
        activeProfile === undefined
          ? -1
          : choices.findIndex(({id}) => id === `profile:${activeProfile}`);
      const selected = activeIndex < 0 ? choices.length - 1 : activeIndex;
      this.update({
        step: 'profile-choice',
        title: 'Select a global profile',
        choices,
        selectedIndex: selected,
        providerBinaries,
        busy: false,
      });
    } catch (error: unknown) {
      this.update({busy: false, error: errorMessage(error)});
    }
  }

  public waitForResult(): Promise<SettingsWizardResult> {
    return this.result;
  }

  public move(delta: number): void {
    if (this.snapshot.busy || this.snapshot.choices.length === 0) return;
    const count = this.snapshot.choices.length;
    const selectedIndex = (this.snapshot.selectedIndex + delta + count) % count;
    this.update({selectedIndex, error: undefined});
  }

  public type(value: string): void {
    if (this.snapshot.busy || !textSteps.has(this.snapshot.step)) return;
    const printable = Array.from(value)
      .filter((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
      })
      .join('');
    if (printable !== '')
      this.update({input: `${this.snapshot.input}${printable}`, error: undefined});
  }

  public backspace(): void {
    if (this.snapshot.busy || !textSteps.has(this.snapshot.step)) return;
    this.update({input: this.snapshot.input.slice(0, -1), error: undefined});
  }

  public cancel(): void {
    if (this.snapshot.step === 'completed' || this.snapshot.step === 'cancelled') return;
    this.update({
      step: 'cancelled',
      title: 'Global profile setup cancelled',
      choices: [],
      busy: false,
      saveEligible: false,
    });
    this.finish({kind: 'cancelled'});
  }

  public async submit(): Promise<void> {
    if (this.snapshot.busy) return;
    this.update({error: undefined});
    switch (this.snapshot.step) {
      case 'profile-choice':
        this.submitProfileChoice();
        return;
      case 'profile-name':
        this.submitProfileName();
        return;
      case 'supervisor-provider':
        this.submitSupervisorProvider();
        return;
      case 'supervisor-model':
        this.submitSupervisorModel();
        return;
      case 'reasoning-effort':
        this.submitReasoningEffort();
        return;
      case 'worker-provider':
        await this.submitWorkerProvider();
        return;
      case 'worker-model-choice':
        await this.submitWorkerModelChoice();
        return;
      case 'worker-model':
        await this.submitWorkerModel();
        return;
      case 'validation':
        await this.submitValidation();
        return;
      case 'warning-confirmation':
        this.submitWarningConfirmation();
        return;
      case 'review':
        await this.submitReview();
        return;
      case 'loading':
      case 'saving':
      case 'completed':
      case 'cancelled':
        return;
    }
  }

  private selectedChoice(): SettingsChoice | undefined {
    return this.snapshot.choices[this.snapshot.selectedIndex];
  }

  private submitProfileChoice(): void {
    const choice = this.selectedChoice();
    if (choice?.id === 'create-profile') {
      const suggestedName = this.suggestedProfileName();
      this.update({
        step: 'profile-name',
        title: 'Name the global profile',
        choices: [],
        selectedIndex: 0,
        input: suggestedName,
        draft: {},
      });
      return;
    }
    const name = choice?.id.startsWith('profile:') === true ? choice.id.slice(8) : undefined;
    const profile = name === undefined ? undefined : this.profiles[name];
    if (name === undefined || profile === undefined) {
      this.update({error: 'Select an existing profile or create a new one.'});
      return;
    }
    this.showSupervisorProviders({
      profileName: name,
      supervisorProvider: profile.supervisor.provider,
      ...(profile.supervisor.model === undefined
        ? {}
        : {supervisorModel: profile.supervisor.model}),
      ...(profile.supervisor.reasoningEffort === undefined
        ? {}
        : {reasoningEffort: profile.supervisor.reasoningEffort}),
      workerProvider: profile.worker.provider,
      ...(profile.worker.model === undefined ? {} : {workerModel: profile.worker.model}),
    });
  }

  private suggestedProfileName(): string {
    const candidate = this.dependencies.initialProfile;
    if (candidate === undefined || this.profiles[candidate] !== undefined) return '';
    try {
      return normalizeProfileName(candidate);
    } catch {
      return '';
    }
  }

  private submitProfileName(): void {
    try {
      const profileName = normalizeProfileName(this.snapshot.input);
      this.showSupervisorProviders({profileName});
    } catch (error: unknown) {
      this.update({error: errorMessage(error)});
    }
  }

  private showSupervisorProviders(draft: Readonly<Partial<SettingsDraft>>): void {
    const choices = SETTINGS_PROVIDER_CATALOG.supervisor.map(
      ({id, displayName, defaultBinary}) => ({
        id,
        label: `${displayName} (${this.snapshot.providerBinaries[id] ?? defaultBinary})`,
      }),
    );
    this.update({
      step: 'supervisor-provider',
      title: 'Select the supervisor provider',
      choices,
      selectedIndex: this.choiceIndex(choices, draft.supervisorProvider),
      input: '',
      draft,
      validation: undefined,
      saveEligible: false,
    });
  }

  private submitSupervisorProvider(): void {
    const provider = this.selectedChoice()?.id;
    if (provider === undefined) return;
    const sameProvider = provider === this.snapshot.draft.supervisorProvider;
    const draft = sameProvider
      ? {...this.snapshot.draft, supervisorProvider: provider}
      : {...withoutSupervisorModel(this.snapshot.draft), supervisorProvider: provider};
    this.update({
      step: 'supervisor-model',
      title: 'Enter the exact supervisor model',
      choices: [],
      selectedIndex: 0,
      input: sameProvider ? (this.snapshot.draft.supervisorModel ?? '') : '',
      draft,
    });
  }

  private submitSupervisorModel(): void {
    const model = this.snapshot.input.trim();
    if (model === '') {
      this.update({error: 'Enter the exact supervisor model; no fallback will be selected.'});
      return;
    }
    const choices = SETTINGS_PROVIDER_CATALOG.supervisor[0].reasoningEfforts.map((effort) => ({
      id: effort,
      label: effort,
    }));
    this.update({
      step: 'reasoning-effort',
      title: 'Select Codex reasoning effort',
      choices,
      selectedIndex: this.choiceIndex(choices, this.snapshot.draft.reasoningEffort ?? 'high'),
      input: '',
      draft: {...this.snapshot.draft, supervisorModel: model},
    });
  }

  private submitReasoningEffort(): void {
    const reasoningEffort = this.selectedChoice()?.id;
    if (reasoningEffort === undefined) return;
    const choices = SETTINGS_PROVIDER_CATALOG.worker.map(({id, displayName, defaultBinary}) => ({
      id,
      label: `${displayName} (${this.snapshot.providerBinaries[id] ?? defaultBinary})`,
    }));
    this.update({
      step: 'worker-provider',
      title: 'Select the worker provider',
      choices,
      selectedIndex: this.choiceIndex(choices, this.snapshot.draft.workerProvider),
      input: '',
      draft: {...this.snapshot.draft, reasoningEffort},
    });
  }

  private async submitWorkerProvider(): Promise<void> {
    const workerProvider = this.selectedChoice()?.id;
    if (workerProvider === undefined) return;
    const previousProvider = this.snapshot.draft.workerProvider;
    const draft =
      workerProvider === previousProvider
        ? {...this.snapshot.draft, workerProvider}
        : {...withoutWorkerModel(this.snapshot.draft), workerProvider};
    this.update({busy: true, title: 'Discovering worker models', draft});
    try {
      const models = (await this.dependencies.discoverWorkerModels(workerProvider, draft)).filter(
        ({available}) => available,
      );
      if (models.length === 0) {
        this.showManualWorkerModel(draft);
        return;
      }
      const choices: SettingsChoice[] = [
        ...models.map(({id, displayName}) => ({id: `model:${id}`, label: displayName ?? id})),
        {id: 'manual-model', label: 'Enter model manually'},
      ];
      const selectedModel = draft.workerModel;
      const discoveredSelection =
        selectedModel === undefined
          ? 0
          : choices.findIndex(({id}) => id === `model:${selectedModel}`);
      this.update({
        step: 'worker-model-choice',
        title: 'Select the exact worker model',
        choices,
        selectedIndex: discoveredSelection < 0 ? choices.length - 1 : discoveredSelection,
        input: '',
        busy: false,
        draft,
      });
    } catch (error: unknown) {
      this.showManualWorkerModel(draft, `Model discovery failed: ${errorMessage(error)}`);
    }
  }

  private showManualWorkerModel(draft: Readonly<Partial<SettingsDraft>>, error?: string): void {
    this.update({
      step: 'worker-model',
      title: 'Enter the exact worker model',
      choices: [],
      selectedIndex: 0,
      input: draft.workerModel ?? '',
      busy: false,
      draft,
      ...(error === undefined ? {} : {error}),
    });
  }

  private async submitWorkerModelChoice(): Promise<void> {
    const choice = this.selectedChoice()?.id;
    if (choice === 'manual-model') {
      this.showManualWorkerModel(this.snapshot.draft);
      return;
    }
    if (choice?.startsWith('model:') !== true) return;
    await this.runValidation({...this.snapshot.draft, workerModel: choice.slice(6)});
  }

  private async submitWorkerModel(): Promise<void> {
    const model = this.snapshot.input.trim();
    if (model === '') {
      this.update({error: 'Enter the exact worker model; no fallback will be selected.'});
      return;
    }
    await this.runValidation({...this.snapshot.draft, workerModel: model});
  }

  private async runValidation(rawDraft: Readonly<Partial<SettingsDraft>>): Promise<void> {
    let draft: SettingsDraft;
    try {
      draft = this.completeDraft(rawDraft);
    } catch (error: unknown) {
      this.update({error: errorMessage(error)});
      return;
    }
    this.update({
      step: 'validation',
      title: 'Checking configured providers and models',
      choices: [],
      selectedIndex: 0,
      input: '',
      draft,
      busy: true,
      validation: undefined,
      saveEligible: false,
    });
    try {
      const result = await this.dependencies.validate(draft);
      const choices: SettingsChoice[] =
        result.status === 'FAIL'
          ? [
              {id: 'retry', label: 'Retry validation'},
              {id: 'edit', label: 'Edit profile'},
            ]
          : [{id: 'continue', label: 'Continue'}];
      this.update({
        title:
          result.status === 'FAIL'
            ? 'Provider validation failed'
            : result.status === 'WARN'
              ? 'Provider validation completed with warnings'
              : 'Provider validation passed',
        choices,
        selectedIndex: 0,
        busy: false,
        validation: result,
        saveEligible: result.status === 'PASS',
      });
    } catch (error: unknown) {
      this.update({
        title: 'Provider validation failed',
        choices: [
          {id: 'retry', label: 'Retry validation'},
          {id: 'edit', label: 'Edit profile'},
        ],
        busy: false,
        validation: {
          status: 'FAIL',
          checks: [
            {role: 'supervisor', status: 'FAIL', message: errorMessage(error)},
            {role: 'worker', status: 'FAIL', message: 'Validation did not complete.'},
          ],
          workerModels: [],
        },
      });
    }
  }

  private async submitValidation(): Promise<void> {
    const result = this.snapshot.validation;
    const choice = this.selectedChoice()?.id;
    if (result === undefined) return;
    if (result.status === 'FAIL') {
      if (choice === 'retry') await this.runValidation(this.snapshot.draft);
      if (choice === 'edit') this.showSupervisorProviders(this.snapshot.draft);
      return;
    }
    if (choice !== 'continue') return;
    if (result.status === 'WARN') {
      this.update({
        step: 'warning-confirmation',
        title: 'Confirm provider validation warning',
        choices: [
          {id: 'back', label: 'Back to validation'},
          {id: 'confirm-warning', label: 'Accept warning and continue'},
        ],
        selectedIndex: 0,
        saveEligible: false,
      });
      return;
    }
    this.showReview();
  }

  private submitWarningConfirmation(): void {
    if (this.selectedChoice()?.id === 'confirm-warning') this.showReview();
    else
      this.update({
        step: 'validation',
        title: 'Provider validation completed with warnings',
        choices: [{id: 'continue', label: 'Continue'}],
        selectedIndex: 0,
      });
  }

  private showReview(): void {
    this.update({
      step: 'review',
      title: 'Review the global profile',
      choices: [
        {id: 'back', label: 'Back to providers'},
        {id: 'save', label: 'Save global profile'},
      ],
      selectedIndex: 0,
      saveEligible: true,
    });
  }

  private async submitReview(): Promise<void> {
    if (this.selectedChoice()?.id === 'back') {
      this.showSupervisorProviders(this.snapshot.draft);
      return;
    }
    if (this.selectedChoice()?.id !== 'save' || !this.snapshot.saveEligible) return;
    let draft: SettingsDraft;
    try {
      draft = this.completeDraft(this.snapshot.draft);
    } catch (error: unknown) {
      this.update({error: errorMessage(error)});
      return;
    }
    this.update({step: 'saving', title: 'Saving global profile', choices: [], busy: true});
    try {
      await this.dependencies.service.save(draft);
      this.update({
        step: 'completed',
        title: `Global profile ${draft.profileName} saved`,
        busy: false,
        saveEligible: false,
      });
      this.finish({kind: 'saved', profileName: draft.profileName});
    } catch (error: unknown) {
      this.update({
        step: 'review',
        title: 'Review the global profile',
        choices: [
          {id: 'back', label: 'Back to providers'},
          {id: 'save', label: 'Retry save'},
        ],
        selectedIndex: 0,
        busy: false,
        error: errorMessage(error),
      });
    }
  }

  private completeDraft(draft: Readonly<Partial<SettingsDraft>>): SettingsDraft {
    const profileName = normalizeProfileName(draft.profileName ?? '');
    const supervisorProvider = draft.supervisorProvider?.trim();
    const supervisorModel = draft.supervisorModel?.trim();
    const workerProvider = draft.workerProvider?.trim();
    const workerModel = draft.workerModel?.trim();
    if (
      supervisorProvider === undefined ||
      supervisorProvider === '' ||
      supervisorModel === undefined ||
      supervisorModel === '' ||
      workerProvider === undefined ||
      workerProvider === '' ||
      workerModel === undefined ||
      workerModel === ''
    ) {
      throw new Error('The profile is incomplete; providers and exact models are required.');
    }
    return {
      profileName,
      supervisorProvider,
      supervisorModel,
      ...(draft.reasoningEffort === undefined ? {} : {reasoningEffort: draft.reasoningEffort}),
      workerProvider,
      workerModel,
    };
  }

  private choiceIndex(choices: readonly SettingsChoice[], selectedId: string | undefined): number {
    if (selectedId === undefined) return 0;
    const index = choices.findIndex(({id}) => id === selectedId);
    return index < 0 ? 0 : index;
  }

  private finish(result: SettingsWizardResult): void {
    const resolve = this.resultResolve;
    if (resolve === undefined) return;
    this.resultResolve = undefined;
    resolve(result);
  }

  private update(changes: SettingsSnapshotChanges): void {
    const compact = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    );
    this.snapshot = {...this.snapshot, ...compact};
    if ('validation' in changes && changes.validation === undefined) {
      const next = {...this.snapshot};
      delete next.validation;
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
