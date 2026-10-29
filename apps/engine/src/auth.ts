import crypto from 'node:crypto';

export class AuthError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

export interface AuthUser {
  id: string;
  role?: string;
  email?: string;
}

export interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

export interface JwtPayload {
  sub: string;
  iss?: string;
  aud?: string;
  iat: number;
  exp: number;
  role?: string;
  email?: string;
  [key: string]: unknown;
}

export interface CreateTokenOptions {
  sub: string;
  role?: string;
  email?: string;
  expiresInSeconds?: number;
  issuer?: string;
  audience?: string;
}

export interface VerifyTokenOptions {
  expectedIssuer?: string;
  expectedAudience?: string;
  clockToleranceSeconds?: number;
}

export const DEFAULT_JWT_ISSUER = 'orchestrate';
export const DEFAULT_JWT_AUDIENCE = 'orchestrate-api';
export const INSECURE_DEV_JWT_SECRET = 'orchestrate-dev-secret-do-not-use-in-production-min-32-chars';

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * Creates a signed HS256 JWT using Node.js built-in crypto.
 */
export function createAuthToken(
  options: CreateTokenOptions,
  secret: string
): string {
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('createAuthToken: secret must be a non-empty string.');
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 3600; // default 1 hour

  const header: JwtHeader = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload: JwtPayload = {
    sub: options.sub,
    iss: options.issuer ?? DEFAULT_JWT_ISSUER,
    aud: options.audience ?? DEFAULT_JWT_AUDIENCE,
    iat: now,
    exp: now + expiresIn,
    ...(options.role ? { role: options.role } : {}),
    ...(options.email ? { email: options.email } : {}),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(message);
  const signature = base64UrlEncode(hmac.digest());

  return `${message}.${signature}`;
}

/**
 * Cryptographically verifies an HS256 JWT.
 * Validates format, signature (constant-time), expiration, issuer, and audience.
 */
export function verifyAuthToken(
  token: string,
  secret: string,
  options?: VerifyTokenOptions
): JwtPayload {
  if (!token || typeof token !== 'string') {
    throw new AuthError('Missing or empty authentication token.', 401);
  }

  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new AuthError('Server authentication secret is not configured.', 500);
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    throw new AuthError('Malformed token structure: must contain header, payload, and signature.', 401);
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Validate Header
  let header: JwtHeader;
  try {
    const rawHeader = base64UrlDecode(headerB64).toString('utf8');
    header = JSON.parse(rawHeader);
  } catch {
    throw new AuthError('Malformed token header.', 401);
  }

  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new AuthError('Unsupported token algorithm or type. Only HS256 JWT is accepted.', 401);
  }

  // 2. Verify Cryptographic Signature with Timing-Safe Comparison
  const message = `${headerB64}.${payloadB64}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(message);
  const expectedSignatureBuf = hmac.digest();
  const actualSignatureBuf = base64UrlDecode(signatureB64);

  if (
    actualSignatureBuf.length !== expectedSignatureBuf.length ||
    !crypto.timingSafeEqual(actualSignatureBuf, expectedSignatureBuf)
  ) {
    throw new AuthError('Invalid token signature.', 401);
  }

  // 3. Parse and Validate Payload
  let payload: JwtPayload;
  try {
    const rawPayload = base64UrlDecode(payloadB64).toString('utf8');
    payload = JSON.parse(rawPayload);
  } catch {
    throw new AuthError('Malformed token payload.', 401);
  }

  if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    throw new AuthError('Token payload must include a valid non-empty subject (sub).', 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const tolerance = options?.clockToleranceSeconds ?? 0;

  // 4. Validate Expiry
  if (typeof payload.exp !== 'number' || payload.exp + tolerance < now) {
    throw new AuthError('Authentication token has expired.', 401);
  }

  // 5. Validate Not Before / Issued At
  if (typeof payload.iat === 'number' && payload.iat - tolerance > now) {
    throw new AuthError('Token issued in the future.', 401);
  }

  // 6. Validate Issuer
  const expectedIssuer = options?.expectedIssuer ?? DEFAULT_JWT_ISSUER;
  if (expectedIssuer && payload.iss !== expectedIssuer) {
    throw new AuthError(`Invalid token issuer: expected "${expectedIssuer}", got "${payload.iss}".`, 401);
  }

  // 7. Validate Audience
  const expectedAudience = options?.expectedAudience ?? DEFAULT_JWT_AUDIENCE;
  if (expectedAudience && payload.aud !== expectedAudience) {
    throw new AuthError(`Invalid token audience: expected "${expectedAudience}", got "${payload.aud}".`, 401);
  }

  return payload;
}

/**
 * Extracts Bearer token from HTTP Authorization header.
 * Rejects invalid prefixes, extra tokens, and malformed strings.
 */
export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }
  const trimmed = authHeader.trim();
  const match = trimmed.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/);
  if (!match) {
    return null;
  }
  return match[1];
}

/**
 * Resolves the active server JWT secret based on configuration and environment.
 * In production, strictly enforces secret presence and minimum complexity.
 */
export function resolveJwtSecret(configuredSecret?: string): string {
  const secret = configuredSecret || process.env.ORCHESTRATE_JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!secret || secret.trim().length === 0) {
      throw new Error(
        'SECURITY INVARIANT VIOLATION: ORCHESTRATE_JWT_SECRET must be set in production mode.'
      );
    }
    if (secret === INSECURE_DEV_JWT_SECRET) {
      throw new Error(
        'SECURITY INVARIANT VIOLATION: Default development JWT secret cannot be used in production.'
      );
    }
    if (secret.length < 32) {
      throw new Error(
        'SECURITY INVARIANT VIOLATION: Production JWT secret must be at least 32 characters.'
      );
    }
    return secret;
  }

  return secret || INSECURE_DEV_JWT_SECRET;
}
