// src/lib/encryption/index.ts
// AES-256-GCM authenticated encryption for refresh tokens.
// The encryption key lives ONLY in process.env.ENCRYPTION_KEY — never in code.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV — standard for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Add it to .env.local (64 hex chars = 32 bytes).'
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex characters (32 bytes). Got ${hex.length} chars.`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded blob: IV (12B) || AuthTag (16B) || Ciphertext.
 * NEVER called in browser — server-side only.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv | authTag | ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypts a base64 blob produced by encrypt().
 * NEVER called in browser — server-side only.
 */
export function decrypt(blob: string): string {
  const key = getKey();
  const packed = Buffer.from(blob, 'base64');

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
