import { describe, it, expect } from 'vitest';
import {
  isSecretKey,
  redactSecrets,
  REDACTED_PLACEHOLDER,
  sanitizeSecretText,
} from '../../src/harness/redaction.js';

describe('Structured Redaction', () => {
  describe('isSecretKey', () => {
    it('identifies sensitive credential keys', () => {
      expect(isSecretKey('apiKey')).toBe(true);
      expect(isSecretKey('api_key')).toBe(true);
      expect(isSecretKey('NEBIUS_API_KEY')).toBe(true);
      expect(isSecretKey('secret')).toBe(true);
      expect(isSecretKey('client_secret')).toBe(true);
      expect(isSecretKey('token')).toBe(true);
      expect(isSecretKey('auth_token')).toBe(true);
      expect(isSecretKey('password')).toBe(true);
      expect(isSecretKey('authorization')).toBe(true);
      expect(isSecretKey('bearer')).toBe(true);
    });

    it('exempts tool names and standard field names', () => {
      expect(isSecretKey('name')).toBe(false);
      expect(isSecretKey('toolName')).toBe(false);
      expect(isSecretKey('type')).toBe(false);
      expect(isSecretKey('role')).toBe(false);
    });
  });

  describe('sanitizeSecretText', () => {
    it('redacts Authorization headers', () => {
      const text = 'curl -H "Authorization: Bearer my-secret-token-12345" https://example.com';
      const sanitized = sanitizeSecretText(text);
      expect(sanitized).not.toContain('my-secret-token-12345');
      expect(sanitized).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts Bearer tokens', () => {
      const text = 'Using Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 for auth';
      const sanitized = sanitizeSecretText(text);
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(sanitized).toContain(`Bearer ${REDACTED_PLACEHOLDER}`);
    });

    it('redacts well-known provider tokens (sk-, nvapi-, ghp-)', () => {
      const text = 'Keys: sk-proj12345678901234567890 and nvapi-abcde123456789012345 and ghp_123456789012345678901234';
      const sanitized = sanitizeSecretText(text);
      expect(sanitized).not.toContain('sk-proj12345678901234567890');
      expect(sanitized).not.toContain('nvapi-abcde123456789012345');
      expect(sanitized).not.toContain('ghp_123456789012345678901234');
      expect(sanitized).toContain(REDACTED_PLACEHOLDER);
    });

    it('redacts custom secrets', () => {
      const customKey = 'super-secret-custom-key-xyz';
      const text = `The server used ${customKey} to sign the payload.`;
      const sanitized = sanitizeSecretText(text, [customKey]);
      expect(sanitized).not.toContain(customKey);
      expect(sanitized).toBe(`The server used ${REDACTED_PLACEHOLDER} to sign the payload.`);
    });

    it('redacts .env lines with secrets', () => {
      const envText = 'PORT=3000\nDATABASE_URL=postgres://localhost\nSECRET_KEY=supersecretvalue123\nAPI_KEY=xyz';
      const sanitized = sanitizeSecretText(envText);
      expect(sanitized).toContain('PORT=3000');
      expect(sanitized).toContain('DATABASE_URL=postgres://localhost');
      expect(sanitized).not.toContain('supersecretvalue123');
      expect(sanitized).toContain(`SECRET_KEY=${REDACTED_PLACEHOLDER}`);
      expect(sanitized).toContain(`API_KEY=${REDACTED_PLACEHOLDER}`);
    });

    it('preserves normal technical paths and code', () => {
      const code = 'const filePath = "packages/workspace/src/local-git-repository.ts";\nfunction verify(clean: boolean) { return clean === true; }';
      const sanitized = sanitizeSecretText(code);
      expect(sanitized).toBe(code);
    });

    it('preserves full 40-character commit hashes', () => {
      const commitSha = '0123456789abcdef0123456789abcdef01234567';
      const text = `Checked out commit ${commitSha} on branch main`;
      const sanitized = sanitizeSecretText(text);
      expect(sanitized).toBe(text);
    });

    it('preserves bare "key" in SQL, English prose, and code identifiers', () => {
      const sql = 'CREATE TABLE users (id INT PRIMARY KEY, org_id INT, FOREIGN KEY (org_id) REFERENCES orgs(id));';
      expect(sanitizeSecretText(sql)).toBe(sql);

      const prose = 'The key difference between approach A and approach B is state isolation. The key principles remain unchanged.';
      expect(sanitizeSecretText(prose)).toBe(prose);

      const code = 'const key_function_name = "runVerification"; const keyIdentifier = 42;';
      expect(sanitizeSecretText(code)).toBe(code);
    });

    it('redacts secret assignments with "key:" and "key=" but not bare "key"', () => {
      const secretWithColon = 'key: "secret-value-abcdef123"';
      expect(sanitizeSecretText(secretWithColon)).toBe(`key: "${REDACTED_PLACEHOLDER}`);

      const secretWithEquals = 'key = secret-token-98765432';
      expect(sanitizeSecretText(secretWithEquals)).toBe(`key = ${REDACTED_PLACEHOLDER}`);

      const apiKeyDash = 'api-key: secret-api-key-value-123';
      expect(sanitizeSecretText(apiKeyDash)).toBe(`api-key: ${REDACTED_PLACEHOLDER}`);
    });
  });

  describe('redactSecrets object traversal', () => {
    it('redacts secret object keys and command line credentials', () => {
      const data = {
        toolName: 'execute_command',
        arguments: {
          command: 'node',
          args: ['run.js', '--api-key', 'secret-key-12345', '--password=superpass'],
          auth_token: 'token-xyz',
        },
        env: {
          PATH: '/usr/bin',
          OPENAI_API_KEY: 'sk-12345678901234567890',
        },
      };

      const redacted = redactSecrets(data);

      expect(redacted.arguments.auth_token).toBe(REDACTED_PLACEHOLDER);
      expect(redacted.arguments.args).toEqual([
        'run.js',
        '--api-key',
        REDACTED_PLACEHOLDER,
        `--password=${REDACTED_PLACEHOLDER}`,
      ]);
      expect(redacted.env.OPENAI_API_KEY).toBe(REDACTED_PLACEHOLDER);
      expect(redacted.env.PATH).toBe('/usr/bin');
      expect(redacted.toolName).toBe('execute_command');
    });

    it('preserves ordinary technical content and structure', () => {
      const data = {
        toolName: 'read_file',
        arguments: {
          path: 'src/index.ts',
        },
        result: {
          content: 'export const version = "1.0.0";',
        },
      };

      const redacted = redactSecrets(data);
      expect(redacted).toEqual(data);
    });

    it('produces identical output for identical non-secret data', () => {
      const data1 = { a: 1, b: 'clean text', c: ['src/main.ts'] };
      const data2 = { a: 1, b: 'clean text', c: ['src/main.ts'] };

      expect(redactSecrets(data1)).toEqual(redactSecrets(data2));
    });
  });
});
