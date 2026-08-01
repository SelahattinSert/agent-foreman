import {renderToString, type Key} from 'ink';
import {describe, expect, test, vi} from 'vitest';

import {
  SettingsView,
  handleSettingsInput,
  type SettingsViewController,
} from '../src/tui/settings-tui.js';
import type {SettingsSnapshot} from '../src/settings/settings-controller.js';

const snapshot: SettingsSnapshot = {
  step: 'review',
  title: 'Review the global profile',
  choices: [
    {id: 'back', label: 'Back to providers'},
    {id: 'save', label: 'Save global profile'},
  ],
  selectedIndex: 1,
  input: '',
  providerBinaries: {'codex-cli': '/usr/local/bin/codex', 'gemini-cli': 'gemini'},
  draft: {
    profileName: 'daily',
    supervisorProvider: 'codex-cli',
    supervisorModel: 'supervisor-model',
    reasoningEffort: 'high',
    workerProvider: 'gemini-cli',
    workerModel: 'worker-model',
  },
  validation: {
    status: 'WARN',
    checks: [
      {role: 'supervisor', status: 'WARN', message: 'Exact model cannot be enumerated.'},
      {role: 'worker', status: 'PASS', message: 'Worker is ready.'},
    ],
    workerModels: [],
  },
  busy: false,
  saveEligible: true,
};

const controller = (overrides: Partial<SettingsViewController> = {}): SettingsViewController => ({
  subscribe: () => () => undefined,
  getSnapshot: () => snapshot,
  move: vi.fn(),
  type: vi.fn(),
  backspace: vi.fn(),
  submit: vi.fn(() => Promise.resolve()),
  cancel: vi.fn(),
  ...overrides,
});

const key = (overrides: Partial<Key>): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  ...overrides,
});

describe('SettingsView', () => {
  test('shows numeric progress and a visible cursor for an empty text field', () => {
    const {validation: _validation, ...snapshotWithoutValidation} = snapshot;
    const profileNameSnapshot: SettingsSnapshot = {
      ...snapshotWithoutValidation,
      step: 'profile-name',
      title: 'Name the global profile',
      choices: [],
      selectedIndex: 0,
      input: '',
      draft: {},
      saveEligible: false,
    };
    const frame = renderToString(
      <SettingsView
        controller={controller({getSnapshot: () => profileNameSnapshot})}
        noColor={true}
      />,
    );

    expect(frame).toContain('Step 1/8');
    expect(frame).toContain('Profile name: ▌');
    expect(frame).toContain('Type a profile name, then press Enter');
  });

  test('renders profile, providers, models, validation, and save authority as text', () => {
    const frame = renderToString(<SettingsView controller={controller()} noColor={true} />);

    expect(frame).toContain('Agent Foreman Settings');
    expect(frame).toContain('Step 8/8');
    expect(frame).toContain('Global profile: daily');
    expect(frame).toContain('Supervisor: codex-cli / supervisor-model / high');
    expect(frame).toContain('Supervisor binary: /usr/local/bin/codex');
    expect(frame).toContain('Worker: gemini-cli / worker-model');
    expect(frame).toContain('Worker binary: gemini');
    expect(frame).toContain('WARN supervisor: Exact model cannot be enumerated.');
    expect(frame).toContain('> Save global profile');
    expect(frame).toContain('Esc cancel');
  });

  test('maps arrows, Enter, typing, Backspace, and Escape to controller actions', () => {
    const viewController = controller();
    handleSettingsInput(viewController, '', key({upArrow: true}));
    handleSettingsInput(viewController, '', key({downArrow: true}));
    handleSettingsInput(viewController, 'x', key({}));
    handleSettingsInput(viewController, '', key({backspace: true}));
    handleSettingsInput(viewController, '', key({return: true}));
    handleSettingsInput(viewController, '', key({escape: true}));

    expect(viewController.move).toHaveBeenNthCalledWith(1, -1);
    expect(viewController.move).toHaveBeenNthCalledWith(2, 1);
    expect(viewController.type).toHaveBeenCalledWith('x');
    expect(viewController.backspace).toHaveBeenCalledOnce();
    expect(viewController.submit).toHaveBeenCalledOnce();
    expect(viewController.cancel).toHaveBeenCalledOnce();
  });
});
