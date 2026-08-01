import {describe, expect, test} from 'vitest';

import {getAgentForemanPlatformPaths} from '../src/index.js';

describe('getAgentForemanPlatformPaths', () => {
  test('uses XDG directories on Linux', () => {
    expect(
      getAgentForemanPlatformPaths({
        platform: 'linux',
        environment: {
          HOME: '/users/foreman',
          XDG_CONFIG_HOME: '/xdg/config',
          XDG_DATA_HOME: '/xdg/data',
          XDG_STATE_HOME: '/xdg/state',
        },
      }),
    ).toEqual({
      configDirectory: '/xdg/config/agent-foreman',
      dataDirectory: '/xdg/data/agent-foreman',
      stateDirectory: '/xdg/state/agent-foreman',
    });
  });

  test('uses Windows application data conventions', () => {
    const paths = getAgentForemanPlatformPaths({
      platform: 'win32',
      environment: {
        USERPROFILE: 'C:\\Users\\Foreman',
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
      },
    });
    expect(paths.configDirectory).toContain('Roaming');
    expect(paths.dataDirectory).toContain('Local');
    expect(paths.stateDirectory).toContain('Local');
  });

  test('uses macOS Application Support for all managed data', () => {
    const paths = getAgentForemanPlatformPaths({
      platform: 'darwin',
      environment: {HOME: '/Users/foreman'},
    });
    expect(paths).toEqual({
      configDirectory: '/Users/foreman/Library/Application Support/Agent Foreman',
      dataDirectory: '/Users/foreman/Library/Application Support/Agent Foreman',
      stateDirectory: '/Users/foreman/Library/Application Support/Agent Foreman',
    });
  });
});
