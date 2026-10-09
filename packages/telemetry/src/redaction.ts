export const REDACTED_PLACEHOLDER = '[REDACTED]';

const SECRET_KEY_REGEX =
  /^(.*_)?(api_?keys?|secrets?|tokens?|passwords?|passwd|pwd|auth|authorization|private_keys?|credentials?|jwt|bearer)(_.*)?$/i;

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
  result = result.replace(/\bsk-[a-zA-Z0-9_\-]{16,}\b/g, REDACTED_PLACEHOLDER);
  result = result.replace(/\bnvapi-[a-zA-Z0-9\-_]{16,}\b/g, REDACTED_PLACEHOLDER);
  result = result.replace(/\bghp_[a-zA-Z0-9]{20,}\b/g, REDACTED_PLACEHOLDER);
  result = result.replace(/\bxox[baprs]-[a-zA-Z0-9]{10,}\b/g, REDACTED_PLACEHOLDER);

  // 5. Redact key-value assignment patterns: api_key: ..., api-key=..., password: ..., key: ..., key=...
  // Strictly requires assignment delimiters (':' or '=') so that plain English and SQL clauses
  // (e.g. "PRIMARY KEY", "FOREIGN KEY", "key difference") are never redacted.
  // Supports plural forms and Base64-style characters (+, /, =).
  result = result.replace(
    /(\b(?:api[_-]?keys?|access_?tokens?|auth_?tokens?|secret_?keys?|client_?secrets?|passwords?|passwd|pwd|tokens?|secrets?|credentials?|keys?)\s*[:=]\s*["']?)[a-zA-Z0-9_\-\.\+\/=]{8,}["']?/gi,
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
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SECRET_KEY_REGEX.test(normalized);
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
      /^--(?:api[_-]?keys?|tokens?|passwords?|secrets?|credentials?|auth[_-]?tokens?)=/i.test(arg) ||
      arg.startsWith('-p=')
    ) {
      const eqIdx = arg.indexOf('=');
      redacted.push(`${arg.slice(0, eqIdx + 1)}${REDACTED_PLACEHOLDER}`);
      continue;
    }

    // Check separate flag followed by value
    if (
      /^--(?:api[_-]?keys?|tokens?|passwords?|secrets?|credentials?|auth[_-]?tokens?)$/i.test(arg) ||
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
  const redactedObj: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (isSecretKey(key)) {
      redactedObj[key] = REDACTED_PLACEHOLDER;
      continue;
    }

    // Special handling for command args arrays
    if (key === 'args' && Array.isArray(val)) {
      redactedObj[key] = redactCommandArgs(val);
      continue;
    }

    redactedObj[key] = redactSecrets(val, customSecrets);
  }

  return redactedObj as T;
}
