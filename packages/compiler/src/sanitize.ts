/**
 * Sanitization and secret redaction utilities for the Context Compiler.
 *
 * Ensures that credentials, API keys, passwords, private keys, and authorization
 * tokens never leak into compiled agent prompts or serialized outputs.
 */

export interface SanitizeResult {
  text: string;
  redactionCount: number;
}

type SecretPattern = {
  regex: RegExp;
  replacement: string | ((substring: string, ...args: any[]) => string);
};

const KNOWN_SECRET_PATTERNS: SecretPattern[] = [
  // Private key blocks
  {
    regex: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // Bearer tokens
  {
    regex: /Bearer\s+[A-Za-z0-9_.\-+/~=]{10,}/gi,
    replacement: 'Bearer [REDACTED]',
  },
  // Basic auth in URLs (http://user:pass@host)
  {
    regex: /(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/g,
    replacement: '$1[REDACTED]:[REDACTED]@',
  },
  // Nebius / OpenAI / Anthropic key signatures
  {
    regex: /\b(?:nkn|nebius|sk)-[A-Za-z0-9_-]{16,}\b/gi,
    replacement: '[REDACTED_API_KEY]',
  },
  // Generic key/secret/password key-value pairs (json, yaml, query params, headers)
  {
    regex: /(?:\b(?:api[_-]?key|access[_-]?token|secret|password|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?)([^"'\s\n\r,;&]{6,})(["']?)/gi,
    replacement: (match: string, p1: string, p2: string) => {
      // Keep prefix and trailing quotes, redact value
      const prefix = match.slice(0, match.length - p1.length - p2.length);
      return `${prefix}[REDACTED]${p2}`;
    },
  },
];

/**
 * Sanitizes input text by redacting known secret formats and any explicitly
 * configured or environment-provided sensitive keys.
 */
export function sanitizeText(text: string, additionalSecrets: string[] = []): SanitizeResult {
  if (!text) {
    return { text: '', redactionCount: 0 };
  }

  let result = text;
  let count = 0;

  // 1. Redact additional known secrets (e.g. process.env.NEBIUS_API_KEY)
  const secretsToRedact = new Set(
    additionalSecrets
      .concat(process.env.NEBIUS_API_KEY ? [process.env.NEBIUS_API_KEY] : [])
      .filter((s): s is string => typeof s === 'string' && s.trim().length >= 8)
  );

  for (const secret of secretsToRedact) {
    const trimmed = secret.trim();
    if (result.includes(trimmed)) {
      const occurrences = result.split(trimmed).length - 1;
      count += occurrences;
      result = result.replaceAll(trimmed, '[REDACTED]');
    }
  }

  // 2. Redact regex patterns
  for (const { regex, replacement } of KNOWN_SECRET_PATTERNS) {
    // Reset lastIndex for stateful global regexes
    regex.lastIndex = 0;
    const matches = result.match(regex);
    if (matches && matches.length > 0) {
      count += matches.length;
      if (typeof replacement === 'function') {
        result = result.replace(regex, replacement as any);
      } else {
        result = result.replace(regex, replacement);
      }
    }
  }

  return {
    text: result,
    redactionCount: count,
  };
}
