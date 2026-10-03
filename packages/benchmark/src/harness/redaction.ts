export const REDACTED_PLACEHOLDER = '[REDACTED]';

const SECRET_KEY_REGEX =
  /^(.*_)?(api_?key|secret|token|password|passwd|pwd|auth|authorization|private_key|credential|jwt|bearer)(_.*)?$/i;

const EXEMPT_KEY_NAMES = new Set(['name', 'toolName', 'type', 'format', 'role']);

/**
 * Sanitizes plain text by redacting embedded secrets, bearer tokens, and credentials.
 */
export function sanitizeSecretText(text: string, customSecrets?: string[]): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let result = text;

  // 1. Redact known custom secrets (e.g. process.env secrets)
  if (customSecrets && Array.isArray(customSecrets)) {
    for (const secret of customSecrets) {
      if (typeof secret === 'string' && secret.trim().length >= 4) {
        result = result.split(secret).join(REDACTED_PLACEHOLDER);
      }
    }
  }

  // 2. Redact Authorization headers: "Authorization: Bearer <token>" or "authorization: <token>"
  result = result.replace(
    /(authorization\s*:\s*)(?:bearer\s+)?[^\r\n,;"'\s]+/gi,
    `$1${REDACTED_PLACEHOLDER}`
  );

  // 3. Redact standalone Bearer tokens: "Bearer <token>"
  result = result.replace(
    /\bbearer\s+[a-zA-Z0-9_\-\.]{8,}\b/gi,
    `Bearer ${REDACTED_PLACEHOLDER}`
  );

  // 4. Redact well-known provider token formats
  result = result.replace(/\bsk-[a-zA-Z0-9]{16,}\b/g, REDACTED_PLACEHOLDER);
  result = result.replace(/\bnvapi-[a-zA-Z0-9\-_]{16,}\b/g, REDACTED_PLACEHOLDER);
  result = result.replace(/\bghp_[a-zA-Z0-9]{20,}\b/g, REDACTED_PLACEHOLDER);
  result = result.replace(/\bxox[baprs]-[a-zA-Z0-9]{10,}\b/g, REDACTED_PLACEHOLDER);

  // 5. Redact key-value assignment patterns: api_key: ..., api-key=..., password: ..., key: ..., key=...
  // Strictly requires assignment delimiters (':' or '=') so that plain English and SQL clauses
  // (e.g. "PRIMARY KEY", "FOREIGN KEY", "key difference", "key principles") are never redacted.
  result = result.replace(
    /(\b(?:api[_-]?key|access_?token|auth_?token|secret_?key|client_?secret|password|passwd|pwd|token|secret|key)\s*[:=]\s*["']?)[a-zA-Z0-9_\-\.]{8,}["']?/gi,
    `$1${REDACTED_PLACEHOLDER}`
  );

  // 6. Redact .env style lines: KEY=... or SECRET=...
  result = result.replace(
    /^([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|AUTH|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(.+)$/gim,
    `$1${REDACTED_PLACEHOLDER}`
  );

  return result;
}

/**
 * Checks whether an object key represents a sensitive credential field.
 */
export function isSecretKey(key: string): boolean {
  if (EXEMPT_KEY_NAMES.has(key)) {
    return false;
  }
  return SECRET_KEY_REGEX.test(key);
}

/**
 * Redacts command line arguments when flags indicate credentials.
 */
function redactCommandArgs(args: unknown[]): unknown[] {
  const redacted: unknown[] = [];
  let redactNext = false;

  for (const arg of args) {
    if (typeof arg !== 'string') {
      redacted.push(arg);
      continue;
    }

    if (redactNext) {
      redacted.push(REDACTED_PLACEHOLDER);
      redactNext = false;
      continue;
    }

    // Check flag=value format
    if (
      arg.startsWith('--password=') ||
      arg.startsWith('--token=') ||
      arg.startsWith('--api-key=') ||
      arg.startsWith('--secret=') ||
      arg.startsWith('-p=')
    ) {
      const eqIdx = arg.indexOf('=');
      redacted.push(`${arg.slice(0, eqIdx + 1)}${REDACTED_PLACEHOLDER}`);
      continue;
    }

    // Check separate flag followed by value
    if (
      arg === '--password' ||
      arg === '--token' ||
      arg === '--api-key' ||
      arg === '--secret' ||
      arg === '-p'
    ) {
      redacted.push(arg);
      redactNext = true;
      continue;
    }

    redacted.push(sanitizeSecretText(arg));
  }

  return redacted;
}

/**
 * Recursively applies field-aware structured secret redaction across any JavaScript data structure.
 */
export function redactSecrets<T>(data: T, customSecrets?: string[]): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeSecretText(data, customSecrets) as unknown as T;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSecrets(item, customSecrets)) as unknown as T;
  }

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // If the key itself indicates a secret, redact value
    if (isSecretKey(key)) {
      result[key] = REDACTED_PLACEHOLDER;
      continue;
    }

    // Special command arguments redaction
    if (key === 'args' && Array.isArray(value)) {
      result[key] = redactCommandArgs(value);
      continue;
    }

    // Recursive traversal for nested structures
    result[key] = redactSecrets(value, customSecrets);
  }

  return result as T;
}
