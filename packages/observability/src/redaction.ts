const secretKeyPattern =
  /(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|client[_-]?secret|password|passwd|private[_-]?key|credential|session[_-]?token)/iu;

const redactText = (value: string): string =>
  value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED TOKEN]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s]+)/gu, '$1=[REDACTED]');

export const redactValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[REDACTED CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = secretKeyPattern.test(key) ? '[REDACTED]' : redactValue(item, seen);
  }
  return output;
};
