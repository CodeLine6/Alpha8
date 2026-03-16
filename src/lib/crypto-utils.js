/**
 * @fileoverview Token encryption/decryption utilities for Alpha8.
 *
 * Uses AES-256-GCM via Node.js built-in crypto — no extra npm packages.
 *
 * Encrypted format: `iv:authTag:ciphertext` (all hex-encoded, colon-separated)
 *
 * FALLBACK BEHAVIOUR:
 *   - If TOKEN_ENCRYPTION_KEY is not set: logs a warning and stores/returns plaintext.
 *     Use this for local dev without encryption configured.
 *   - If TOKEN_ENCRYPTION_KEY is set but the stored value is legacy plaintext
 *     (no colons, written before encryption was enabled): decryptToken returns
 *     the plaintext value and logs a warning to rotate the token.
 *     This prevents a hard failure on first deploy after encryption is added.
 *
 * SETUP:
 *   Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   Add to .env:    TOKEN_ENCRYPTION_KEY=<64-char hex string>
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;  // 128-bit auth tag (GCM default)

/**
 * Derive a 32-byte Buffer key from the hex env var.
 * Returns null if TOKEN_ENCRYPTION_KEY is not set.
 * @private
 */
function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) return null;

  if (hex.length !== 64) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      `Got ${hex.length} characters. ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext token using AES-256-GCM.
 *
 * @param {string} plaintext - The access token to encrypt
 * @returns {string} Encrypted value as `iv:authTag:ciphertext` (hex) or
 *                   plaintext unchanged if TOKEN_ENCRYPTION_KEY is not set.
 */
export function encryptToken(plaintext) {
  const key = getKey();

  if (!key) {
    // No encryption key configured — store plaintext with warning
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[crypto-utils] WARNING: TOKEN_ENCRYPTION_KEY is not set. ' +
        'Access token will be stored as plaintext in Redis. ' +
        'Set TOKEN_ENCRYPTION_KEY in .env for production security.'
      );
    }
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Detect whether a string looks like a value encrypted by encryptToken().
 * Encrypted format: `iv:authTag:ciphertext`
 * @private
 */
function looksEncrypted(value) {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [iv, authTag, ciphertext] = parts;
  return (
    /^[0-9a-f]{24}$/i.test(iv) &&       // 12-byte IV
    /^[0-9a-f]{32}$/i.test(authTag) &&   // 16-byte auth tag
    ciphertext.length > 0 &&
    ciphertext.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(ciphertext)
  );
}

/**
 * Decrypt a token value from Redis.
 *
 * Handles four cases:
 *   1. KEY set + value is encrypted → decrypt and return
 *   2. KEY set + value is legacy plaintext → return plaintext + warn
 *   3. KEY not set + value is plaintext → return as-is (dev mode)
 *   4. KEY not set + value looks encrypted → THROW (S2 FIX)
 *
 * @param {string} value - The raw value from Redis
 * @returns {string} Decrypted (or original) access token
 * @throws {Error} If decryption fails or encrypted value used without key
 */
export function decryptToken(value) {
  if (!value) return value;

  const key = getKey();

  if (!key) {
    if (looksEncrypted(value)) {
      const msg =
        'CRITICAL: Redis contains an encrypted token but TOKEN_ENCRYPTION_KEY is not set. ' +
        'The token cannot be decrypted. Either restore the key or run `npm run login`.';
      console.error(`[crypto-utils] ${msg}`);
      throw new Error(msg);
    }
    return value;
  }

  // ── Legacy plaintext guard ────────────────────────────────────────────────
  const parts = value.split(':');
  if (parts.length !== 3) {
    console.warn(
      '[crypto-utils] WARNING: Redis contains a legacy plaintext token. ' +
      'It will be used as-is this session. ' +
      'Run `npm run login` to refresh and store an encrypted token.'
    );
    return value;
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────
  try {
    const [ivHex, authTagHex, encryptedHex] = parts;

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(
      `[crypto-utils] Token decryption failed: ${err.message}. ` +
      'The token may be corrupt or was encrypted with a different TOKEN_ENCRYPTION_KEY. ' +
      'Run `npm run login` to generate a fresh token.'
    );
  }
}