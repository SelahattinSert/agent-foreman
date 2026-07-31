import path from 'node:path';

import {ConfigurationError} from '@agent-foreman/core';

export interface AgentForemanPlatformPaths {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly stateDirectory: string;
}

export interface PlatformPathInput {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

const requiredUserDirectory = (environment: NodeJS.ProcessEnv): string => {
  const userDirectory = environment.HOME ?? environment.USERPROFILE;
  if (userDirectory === undefined || userDirectory.trim() === '') {
    throw new ConfigurationError('Cannot determine the user directory for Agent Foreman data.');
  }
  return path.resolve(userDirectory);
};

export const getAgentForemanPlatformPaths = (
  input: PlatformPathInput = {},
): AgentForemanPlatformPaths => {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const userDirectory = requiredUserDirectory(environment);

  if (platform === 'win32') {
    const applicationData = environment.APPDATA ?? path.join(userDirectory, 'AppData', 'Roaming');
    const localApplicationData =
      environment.LOCALAPPDATA ?? path.join(userDirectory, 'AppData', 'Local');
    return {
      configDirectory: path.join(applicationData, 'Agent Foreman'),
      dataDirectory: path.join(localApplicationData, 'Agent Foreman'),
      stateDirectory: path.join(localApplicationData, 'Agent Foreman'),
    };
  }

  if (platform === 'darwin') {
    const applicationSupport = path.join(userDirectory, 'Library', 'Application Support');
    return {
      configDirectory: path.join(applicationSupport, 'Agent Foreman'),
      dataDirectory: path.join(applicationSupport, 'Agent Foreman'),
      stateDirectory: path.join(applicationSupport, 'Agent Foreman'),
    };
  }

  return {
    configDirectory: path.join(
      environment.XDG_CONFIG_HOME ?? path.join(userDirectory, '.config'),
      'agent-foreman',
    ),
    dataDirectory: path.join(
      environment.XDG_DATA_HOME ?? path.join(userDirectory, '.local', 'share'),
      'agent-foreman',
    ),
    stateDirectory: path.join(
      environment.XDG_STATE_HOME ?? path.join(userDirectory, '.local', 'state'),
      'agent-foreman',
    ),
  };
};
