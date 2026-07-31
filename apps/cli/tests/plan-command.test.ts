import {describe, expect, test} from 'vitest';

import {parsePlanInput} from '../src/index.js';

describe('parsePlanInput', () => {
  test('accepts only the explicit /approve command as textual approval', () => {
    expect(parsePlanInput('/approve')).toEqual({kind: 'approve'});
    expect(parsePlanInput('yes')).toEqual({kind: 'discussion', message: 'yes'});
    expect(parsePlanInput('ok')).toEqual({kind: 'discussion', message: 'ok'});
    expect(parsePlanInput('tamam')).toEqual({kind: 'discussion', message: 'tamam'});
  });

  test('parses change, discussion, cancel, and display commands without shell parsing', () => {
    expect(parsePlanInput('/change Keep the public API stable')).toEqual({
      kind: 'request-change',
      message: 'Keep the public API stable',
    });
    expect(parsePlanInput('/discuss Why this boundary?')).toEqual({
      kind: 'discussion',
      message: 'Why this boundary?',
    });
    expect(parsePlanInput('/cancel')).toEqual({kind: 'cancel'});
    expect(parsePlanInput('/show-plan')).toEqual({kind: 'show-plan'});
    expect(parsePlanInput('/show-json')).toEqual({kind: 'show-json'});
  });

  test('rejects an empty change request', () => {
    expect(() => parsePlanInput('/change')).toThrow(/change message/iu);
  });
});
