import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export function encryptToken(plaintext) {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex) {
    console.warn('⚠️  TOKEN_ENCRYPTION_KEY not set — storing token as plaintext');
    return plaintext;
  }

  try {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw new Error('Key must be 32 bytes (64 hex characters)');

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${ciphertext}`;
  } catch (err) {
    console.warn(`⚠️  Token encryption failed: ${err.message} — storing as plaintext`);
    return plaintext;
  }
}

export function decryptToken(ciphertext) {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex) {
    return ciphertext;
  }

  // If token doesn't look like our encrypted format, assume plaintext
  if (!ciphertext || !ciphertext.includes(':')) {
    return ciphertext;
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    return ciphertext;
  }

  try {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw new Error('Key must be 32 bytes (64 hex characters)');

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(encryptedHex, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  } catch (err) {
    throw new Error(`Token decryption failed: ${err.message}`);
  }
}
