// src/test/encryption.test.ts
// Unit tests for AES-256-GCM encrypt/decrypt.
// Tests the full round-trip, key validation errors, and tamper detection.

import { describe, it, expect, beforeEach } from 'vitest';

// Set a valid 64-char hex key before importing the module so getKey() doesn't throw.
const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

// Dynamic import after env is set
async function getEncryption() {
  // Re-import fresh so the module re-reads ENCRYPTION_KEY
  return await import('@/lib/encryption/index');
}

describe('encrypt / decrypt round-trip', () => {
  it('decrypts back to the original plaintext', async () => {
    const { encrypt, decrypt } = await getEncryption();
    const plaintext = 'my-refresh-token-abc123';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext for the same input (random IV)', async () => {
    const { encrypt } = await getEncryption();
    const a = encrypt('same-token');
    const b = encrypt('same-token');
    expect(a).not.toBe(b);
  });

  it('handles empty string', async () => {
    const { encrypt, decrypt } = await getEncryption();
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('handles long tokens', async () => {
    const { encrypt, decrypt } = await getEncryption();
    const long = 'x'.repeat(4096);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  it('handles unicode tokens', async () => {
    const { encrypt, decrypt } = await getEncryption();
    const unicode = '🔑 توكن مشفر 密钥';
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });
});

describe('key validation', () => {
  it('throws if ENCRYPTION_KEY is not set', async () => {
    delete process.env.ENCRYPTION_KEY;
    const { encrypt } = await getEncryption();
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY is not set');
  });

  it('throws if ENCRYPTION_KEY is too short', async () => {
    process.env.ENCRYPTION_KEY = 'abc123';
    const { encrypt } = await getEncryption();
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY must be 64 hex characters');
  });
});

describe('tamper detection', () => {
  it('throws on corrupted ciphertext (GCM auth tag mismatch)', async () => {
    const { encrypt, decrypt } = await getEncryption();
    const blob = encrypt('secret-token');
    // Flip a byte in the middle of the blob
    const buf = Buffer.from(blob, 'base64');
    buf[20] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });
});
