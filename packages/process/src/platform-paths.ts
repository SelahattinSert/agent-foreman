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

const requiredUserDirectory = (
  environment: NodeJS.ProcessEnv,
  platformPath: typeof path.posix,
): string => {
  const userDirectory = environment.HOME ?? environment.USERPROFILE;
  if (userDirectory === undefined || userDirectory.trim() === '') {
    throw new ConfigurationError('Cannot determine the user directory for Agent Foreman data.');
  }
  return platformPath.resolve(userDirectory);
};

export const getAgentForemanPlatformPaths = (
  input: PlatformPathInput = {},
): AgentForemanPlatformPaths => {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const userDirectory = requiredUserDirectory(environment, platformPath);

  if (platform === 'win32') {
    const applicationData =
      environment.APPDATA ?? platformPath.join(userDirectory, 'AppData', 'Roaming');
    const localApplicationData =
      environment.LOCALAPPDATA ?? platformPath.join(userDirectory, 'AppData', 'Local');
    return {
      configDirectory: platformPath.join(applicationData, 'Agent Foreman'),
      dataDirectory: platformPath.join(localApplicationData, 'Agent Foreman'),
      stateDirectory: platformPath.join(localApplicationData, 'Agent Foreman'),
    };
  }

  if (platform === 'darwin') {
    const applicationSupport = platformPath.join(userDirectory, 'Library', 'Application Support');
    return {
      configDirectory: platformPath.join(applicationSupport, 'Agent Foreman'),
      dataDirectory: platformPath.join(applicationSupport, 'Agent Foreman'),
      stateDirectory: platformPath.join(applicationSupport, 'Agent Foreman'),
    };
  }

  return {
    configDirectory: platformPath.join(
      environment.XDG_CONFIG_HOME ?? platformPath.join(userDirectory, '.config'),
      'agent-foreman',
    ),
    dataDirectory: platformPath.join(
      environment.XDG_DATA_HOME ?? platformPath.join(userDirectory, '.local', 'share'),
      'agent-foreman',
    ),
    stateDirectory: platformPath.join(
      environment.XDG_STATE_HOME ?? platformPath.join(userDirectory, '.local', 'state'),
      'agent-foreman',
    ),
  };
};
