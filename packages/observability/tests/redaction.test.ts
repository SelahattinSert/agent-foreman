import {describe, expect, test} from 'vitest';

import {redactValue} from '../src/index.js';

describe('redactValue', () => {
  test('redacts secret-bearing keys recursively without mutating input', () => {
    const input = {
      safe: 'visible',
      nested: {authorization: 'Bearer super-secret', api_key: 'secret-key', count: 2},
    };

    expect(redactValue(input)).toEqual({
      safe: 'visible',
      nested: {authorization: '[REDACTED]', api_key: '[REDACTED]', count: 2},
    });
    expect(input.nested.authorization).toBe('Bearer super-secret');
  });

  test('redacts common token and private-key patterns inside free text', () => {
    const redacted = redactValue(
      'Authorization: Bearer abc.def.ghi\nOPENAI_API_KEY=sk-example-secret\n-----BEGIN PRIVATE KEY-----\ndata\n-----END PRIVATE KEY-----',
    );

    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('sk-example-secret');
    expect(redacted).not.toContain('data');
    expect(redacted).toContain('[REDACTED]');
  });
});
