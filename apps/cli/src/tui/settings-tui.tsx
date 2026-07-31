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
  return (
    <Box flexDirection="column" paddingX={1} aria-label="Agent Foreman global profile settings">
      <Text bold {...(accent === undefined ? {} : {color: accent})}>
        Agent Foreman Settings
      </Text>
      <Text>
        Step: {snapshot.title}
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
      {snapshot.input === '' ? null : <Text>Input: {snapshot.input}</Text>}
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
