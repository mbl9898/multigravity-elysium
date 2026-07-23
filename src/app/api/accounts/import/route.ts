// src/app/api/accounts/import/route.ts
// POST /api/accounts/import
// Imports accounts from a passphrase-encrypted export bundle.
//
// Body: { bundle: string, password: string }
// Response: { imported: number, skipped: number, details: { imported: string[], skipped: string[] } }

import { NextRequest, NextResponse } from 'next/server';
import { scryptSync, createDecipheriv } from 'crypto';
import { prisma } from '@/lib/database/client';
import { encrypt } from '@/lib/encryption';
import { refreshQuotaForAccount } from '@/lib/database/accounts';

interface ExportedAccount {
  email: string;
  nickname: string | null;
  tier: string | null;
  projectId: string | null;
  refreshToken: string;
  originalCreatedAt: string;
}

interface ExportPayload {
  version: number;
  exportedAt: string;
  exportedBy: string;
  accounts: ExportedAccount[];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { bundle?: unknown; password?: unknown };
    const { bundle, password } = body;

    // Validate inputs
    if (typeof bundle !== 'string' || bundle.trim().length === 0) {
      return NextResponse.json({ error: 'bundle is required.' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.trim().length === 0) {
      return NextResponse.json({ error: 'password is required.' }, { status: 400 });
    }

    // Decode and parse the bundle
    let raw: Buffer;
    try {
      raw = Buffer.from(bundle, 'base64');
    } catch {
      return NextResponse.json(
        { error: 'Invalid bundle format.' },
        { status: 400 }
      );
    }

    // Extract components: salt(16) | iv(12) | authTag(16) | ciphertext(rest)
    const salt = raw.subarray(0, 16);
    const iv = raw.subarray(16, 28);
    const authTag = raw.subarray(28, 44);
    const ciphertext = raw.subarray(44);

    // Derive key
    const key = scryptSync(password, salt, 32);

    // Decrypt
    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return NextResponse.json(
        { error: 'Invalid password or corrupted file.' },
        { status: 400 }
      );
    }

    // Parse payload
    let payload: ExportPayload;
    try {
      payload = JSON.parse(plaintext) as ExportPayload;
    } catch {
      return NextResponse.json(
        { error: 'Failed to parse export file — it may be corrupted.' },
        { status: 400 }
      );
    }

    if (payload.version !== 1 || !Array.isArray(payload.accounts)) {
      return NextResponse.json(
        { error: 'Unsupported export version or invalid format.' },
        { status: 400 }
      );
    }

    const importedEmails: string[] = [];
    const skippedEmails: string[] = [];

    for (const acct of payload.accounts) {
      if (!acct.email || !acct.refreshToken) {
        // Skip malformed entries silently
        continue;
      }

      // Check if already exists
      const existing = await prisma.account.findFirst({
        where: { email: acct.email },
      });

      if (existing) {
        skippedEmails.push(acct.email);
        continue;
      }

      // Create new account with re-encrypted token
      const newAccount = await prisma.account.create({
        data: {
          email: acct.email,
          nickname: acct.nickname ?? undefined,
          tier: acct.tier ?? undefined,
          projectId: acct.projectId ?? undefined,
          encryptedRefreshToken: encrypt(acct.refreshToken),
        },
      });

      importedEmails.push(acct.email);

      // Fire quota refresh in background — don't await
      void refreshQuotaForAccount(newAccount.id, []);
    }

    return NextResponse.json({
      imported: importedEmails.length,
      skipped: skippedEmails.length,
      details: {
        imported: importedEmails,
        skipped: skippedEmails,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[import] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
