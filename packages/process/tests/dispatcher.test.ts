import {describe, expect, test} from 'vitest';

import {ShimRecursionError} from '@agent-foreman/core';

import {decideDispatch} from '../src/index.js';

describe('decideDispatch', () => {
  test.each([
    {args: []},
    {args: ['--help']},
    {args: ['exec', 'Fix the tests']},
    {args: ['review']},
    {args: ['resume']},
    {args: ['--model', 'configured-model']},
    {args: ['app-server']},
    {args: ['agent-foreman-extra']},
  ])('passes normal provider arguments through unchanged: $args', ({args}) => {
    expect(
      decideDispatch({
        args,
        frontendProvider: 'fixture-frontend',
        realBinaryPath: '/opt/provider/bin/provider-real',
        dispatchDepth: 0,
      }),
    ).toEqual({
      kind: 'passthrough',
      executable: '/opt/provider/bin/provider-real',
      args,
      environment: {AGENT_FOREMAN_DISPATCH_DEPTH: '1'},
    });
  });

  test('intercepts only an exact first positional agent-foreman argument', () => {
    expect(
      decideDispatch({
        args: ['agent-foreman', '--profile', 'balanced'],
        frontendProvider: 'fixture-frontend',
        realBinaryPath: '/opt/provider/bin/provider-real',
        dispatchDepth: 0,
      }),
    ).toEqual({
      kind: 'agent-foreman',
      frontendProvider: 'fixture-frontend',
      args: ['--profile', 'balanced'],
    });
  });

  test('does not intercept agent-foreman when it is not the first argument', () => {
    const args = ['exec', 'agent-foreman'];
    expect(
      decideDispatch({
        args,
        frontendProvider: 'fixture-frontend',
        realBinaryPath: '/opt/provider/bin/provider-real',
        dispatchDepth: 0,
      }),
    ).toMatchObject({kind: 'passthrough', args});
  });

  test('fails safely when a recursive shim invocation exceeds depth one', () => {
    expect(() =>
      decideDispatch({
        args: ['--help'],
        frontendProvider: 'fixture-frontend',
        realBinaryPath: '/opt/provider/bin/provider-real',
        dispatchDepth: 2,
      }),
    ).toThrow(ShimRecursionError);
  });
});
