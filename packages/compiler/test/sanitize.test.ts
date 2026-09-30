import { describe, expect, it } from 'vitest';
import { sanitizeText } from '../src/sanitize.js';

describe('sanitizeText', () => {
  it('redacts private key blocks', () => {
    const text = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1+abcdef
-----END RSA PRIVATE KEY-----
`;
    const res = sanitizeText(text);
    expect(res.text).toContain('[REDACTED_PRIVATE_KEY]');
    expect(res.text).not.toContain('MIIEowIBAAKCAQEA0Y1+abcdef');
    expect(res.redactionCount).toBe(1);
  });

  it('redacts Bearer tokens', () => {
    const text = 'Authorization: Bearer ya29.a0AfH6SMD_randomtoken1234567890';
    const res = sanitizeText(text);
    expect(res.text).toBe('Authorization: Bearer [REDACTED]');
    expect(res.redactionCount).toBe(1);
  });

  it('redacts Nebius and OpenAI key formats', () => {
    const text = 'Using key nkn-12345678901234567890 and sk-proj-12345678901234567890';
    const res = sanitizeText(text);
    expect(res.text).toBe('Using key [REDACTED_API_KEY] and [REDACTED_API_KEY]');
    expect(res.redactionCount).toBe(2);
  });

  it('redacts basic auth credentials in URLs', () => {
    const text = 'Connecting to https://user:supersecretpass@example.com/api';
    const res = sanitizeText(text);
    expect(res.text).toBe('Connecting to https://[REDACTED]:[REDACTED]@example.com/api');
    expect(res.redactionCount).toBe(1);
  });

  it('redacts explicit secret list and env secrets', () => {
    const secret = 'super-custom-secret-value-123';
    const text = `The secret is ${secret} in configuration.`;
    const res = sanitizeText(text, [secret]);
    expect(res.text).toBe('The secret is [REDACTED] in configuration.');
    expect(res.redactionCount).toBe(1);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeText('')).toEqual({ text: '', redactionCount: 0 });
  });
});
