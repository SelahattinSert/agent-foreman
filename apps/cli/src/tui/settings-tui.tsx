import React, {useSyncExternalStore} from 'react';
import {Box, Text, render, useInput, type Instance, type Key} from 'ink';

import type {
  SettingsController,
  SettingsSnapshot,
  SettingsWizardResult,
} from '../settings/settings-controller.js';

export interface SettingsViewController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SettingsSnapshot;
  readonly move: (delta: number) => void;
  readonly type: (value: string) => void;
  readonly backspace: () => void;
  readonly submit: () => Promise<void>;
  readonly cancel: () => void;
}

export interface SettingsViewProps {
  readonly controller: SettingsViewController;
  readonly noColor: boolean;
  readonly configPath?: string;
}

const SETTINGS_TOTAL_STEPS = 8;

const settingsStepNumber = (step: SettingsSnapshot['step']): number => {
  switch (step) {
    case 'loading':
    case 'profile-choice':
    case 'profile-name':
      return 1;
    case 'supervisor-provider':
      return 2;
    case 'supervisor-model':
      return 3;
    case 'reasoning-effort':
      return 4;
    case 'worker-provider':
      return 5;
    case 'worker-model-choice':
    case 'worker-model':
      return 6;
    case 'validation':
    case 'warning-confirmation':
      return 7;
    case 'review':
    case 'saving':
    case 'completed':
    case 'cancelled':
      return 8;
  }
};

const textField = (
  snapshot: SettingsSnapshot,
): {readonly label: string; readonly hint: string} | undefined => {
  if (snapshot.step === 'profile-name') {
    return {label: 'Profile name', hint: 'Type a profile name, then press Enter'};
  }
  if (snapshot.step === 'supervisor-model') {
    return {label: 'Supervisor model', hint: 'Type the exact supervisor model, then press Enter'};
  }
  if (snapshot.step === 'worker-model') {
    return {label: 'Worker model', hint: 'Type the exact worker model, then press Enter'};
  }
  return undefined;
};

export const handleSettingsInput = (
  controller: SettingsViewController,
  character: string,
  key: Key,
): void => {
  if (key.escape || (key.ctrl && character.toLowerCase() === 'c')) {
    controller.cancel();
    return;
  }
  if (key.upArrow) {
    controller.move(-1);
    return;
  }
  if (key.downArrow) {
    controller.move(1);
    return;
  }
  if (key.return) {
    void controller.submit();
    return;
  }
  if (key.backspace || key.delete) {
    controller.backspace();
    return;
  }
  if (!key.ctrl && !key.meta && character !== '') controller.type(character);
};

const providerSummary = (snapshot: SettingsSnapshot): React.ReactElement => (
  <Box flexDirection="column" marginTop={1} aria-label="Candidate global profile">
    <Text>Global profile: {snapshot.draft.profileName ?? 'not selected'}</Text>
    <Text>
      Supervisor: {snapshot.draft.supervisorProvider ?? 'not selected'} /{' '}
      {snapshot.draft.supervisorModel ?? 'model not set'}
      {snapshot.draft.reasoningEffort === undefined ? '' : ` / ${snapshot.draft.reasoningEffort}`}
    </Text>
    <Text>
      Supervisor binary:{' '}
      {snapshot.draft.supervisorProvider === undefined
        ? 'not selected'
        : (snapshot.providerBinaries[snapshot.draft.supervisorProvider] ?? 'not configured')}
    </Text>
    <Text>
      Worker: {snapshot.draft.workerProvider ?? 'not selected'} /{' '}
      {snapshot.draft.workerModel ?? 'model not set'}
    </Text>
    <Text>
      Worker binary:{' '}
      {snapshot.draft.workerProvider === undefined
        ? 'not selected'
        : (snapshot.providerBinaries[snapshot.draft.workerProvider] ?? 'not configured')}
    </Text>
  </Box>
);

export const SettingsView = ({
  controller,
  noColor,
  configPath,
}: SettingsViewProps): React.ReactElement => {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useInput((character, key) => {
    handleSettingsInput(controller, character, key);
  });
  const accent = noColor ? undefined : 'cyan';
  const field = textField(snapshot);
  return (
    <Box flexDirection="column" paddingX={1} aria-label="Agent Foreman global profile settings">
      <Text bold {...(accent === undefined ? {} : {color: accent})}>
        Agent Foreman Settings
      </Text>
      <Text>
        Step {settingsStepNumber(snapshot.step)}/{SETTINGS_TOTAL_STEPS}: {snapshot.title}
        {snapshot.busy ? ' · working' : ''}
      </Text>
      {configPath === undefined ? null : <Text dimColor>Global config: {configPath}</Text>}
      {providerSummary(snapshot)}
      {snapshot.choices.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1} aria-label="Available settings actions">
          {snapshot.choices.map((choice, index) => (
            <Text key={choice.id}>
              {index === snapshot.selectedIndex ? '>' : ' '} {choice.label}
            </Text>
          ))}
        </Box>
      )}
      {field === undefined ? null : (
        <Box flexDirection="column" marginTop={1} aria-label={field.label}>
          <Text>
            {field.label}: {snapshot.input}
            <Text inverse>▌</Text>
          </Text>
          <Text dimColor>{field.hint}</Text>
        </Box>
      )}
      {snapshot.validation === undefined ? null : (
        <Box flexDirection="column" marginTop={1} aria-label="Provider validation">
          <Text>Validation: {snapshot.validation.status}</Text>
          {snapshot.validation.checks.map((check) => (
            <Text key={check.role}>
              {check.status} {check.role}: {check.message}
            </Text>
          ))}
        </Box>
      )}
      {snapshot.busy ? <Text>Checking configured providers…</Text> : null}
      {snapshot.error === undefined ? null : (
        <Text {...(noColor ? {} : {color: 'red'})}>Error: {snapshot.error}</Text>
      )}
      <Text dimColor>↑/↓ select · Enter continue · Backspace edit · Esc cancel</Text>
    </Box>
  );
};

export interface RunSettingsTuiOptions {
  readonly controller: SettingsController;
  readonly noColor: boolean;
  readonly screenReader: boolean;
  readonly configPath: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

export const runSettingsTui = async (
  options: RunSettingsTuiOptions,
): Promise<SettingsWizardResult> => {
  await options.controller.initialize();
  let instance: Instance | undefined;
  try {
    instance = render(
      <SettingsView
        controller={options.controller}
        noColor={options.noColor}
        configPath={options.configPath}
      />,
      {
        exitOnCtrlC: false,
        isScreenReaderEnabled: options.screenReader,
        incrementalRendering: !options.screenReader,
        ...(options.stdin === undefined ? {} : {stdin: options.stdin}),
        ...(options.stdout === undefined ? {} : {stdout: options.stdout}),
        ...(options.stderr === undefined ? {} : {stderr: options.stderr}),
      },
    );
    return await options.controller.waitForResult();
  } finally {
    instance?.unmount();
  }
};
