import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface CredentialEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyVersion: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export type CredentialPayload = Record<string, string>;
type RuntimeEnv = Record<string, string | undefined>;

export class CredentialIntegrityError extends Error {
  constructor() {
    super('Credential data could not be verified.');
    this.name = 'CredentialIntegrityError';
  }
}

export class CredentialConfigurationError extends Error {
  constructor() {
    super('Credential storage is not configured.');
    this.name = 'CredentialConfigurationError';
  }
}

const PLACEHOLDERS = new Set(['', 'replace-with-a-32-byte-base64-key', 'server-only-placeholder', 'your-key-here']);

function keyFor(version: string, env: RuntimeEnv): Buffer {
  const configuredVersion = env.CREDENTIAL_KEY_VERSION ?? 'v1';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) throw new CredentialConfigurationError();
  const versionedName = `CREDENTIAL_MASTER_KEY_${version.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  const encoded = env[versionedName] ?? (version === configuredVersion ? env.CREDENTIAL_MASTER_KEY : undefined);
  if (!encoded || PLACEHOLDERS.has(encoded)) throw new CredentialConfigurationError();
  let key: Buffer;
  try { key = Buffer.from(encoded, 'base64'); } catch { throw new CredentialConfigurationError(); }
  if (key.length !== 32) throw new CredentialConfigurationError();
  return key;
}

export function getCredentialKeyVersion(env: RuntimeEnv = process.env): string {
  const version = env.CREDENTIAL_KEY_VERSION ?? 'v1';
  keyFor(version, env);
  return version;
}

export function validateCredentialPayload(payload: unknown): CredentialPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Credential payload is invalid.');
  const result: CredentialPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || typeof value !== 'string' || !value.trim() || value.length > 4096) {
      throw new Error('Credential payload is invalid.');
    }
    result[key] = value;
  }
  if (!Object.keys(result).length || Object.keys(result).length > 32) throw new Error('Credential payload is invalid.');
  return result;
}

export function encryptCredentialPayload(payload: unknown, env: RuntimeEnv = process.env): CredentialEnvelope {
  const safePayload = validateCredentialPayload(payload);
  const keyVersion = getCredentialKeyVersion(env);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(keyVersion, env), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(safePayload), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    keyVersion,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptCredentialEnvelope(envelope: CredentialEnvelope, env: RuntimeEnv = process.env): CredentialPayload {
  try {
    if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' || !envelope.nonce || !envelope.ciphertext || !envelope.authTag) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', keyFor(envelope.keyVersion, env), Buffer.from(envelope.nonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    return validateCredentialPayload(JSON.parse(plaintext));
  } catch {
    throw new CredentialIntegrityError();
  }
}

/** Use generic text when an exception may have originated near a secret. */
export function safeCredentialError(): string { return 'Credential operation failed.'; }

/** Redacts common secret-shaped material before diagnostics or support metadata. */
export function redactCredentialText(value: string): string {
  return value
    .replace(/(password|passphrase|secret|api[_ -]?key|token|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[redacted-key]');
}
