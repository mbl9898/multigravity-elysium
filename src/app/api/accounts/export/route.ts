// src/app/api/accounts/export/route.ts
// POST /api/accounts/export
// Exports accounts as a passphrase-encrypted bundle.
//
// Body: { password: string, accountIds?: string[] }
//   accountIds — optional allowlist; if omitted or empty, all accounts are exported.
// Response: { bundle: string } — base64-encoded blob: salt(16) | iv(12) | authTag(16) | ciphertext

import { NextRequest, NextResponse } from 'next/server';
import { scryptSync, randomBytes, createCipheriv } from 'crypto';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { password?: unknown; accountIds?: unknown };
    const { password, accountIds } = body;

    // Validate password
    if (typeof password !== 'string' || password.trim().length < 4) {
      return NextResponse.json(
        { error: 'Password must be a string of at least 4 characters.' },
        { status: 400 }
      );
    }

    // Validate optional accountIds filter
    let idFilter: string[] | null = null;
    if (accountIds !== undefined && accountIds !== null) {
      if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== 'string')) {
        return NextResponse.json(
          { error: 'accountIds must be an array of strings.' },
          { status: 400 }
        );
      }
      if ((accountIds as string[]).length > 0) {
        idFilter = accountIds as string[];
      }
    }

    // Fetch accounts — scoped to the filter if one was provided
    const accounts = await prisma.account.findMany({
      where: idFilter ? { id: { in: idFilter } } : undefined,
      select: {
        id: true,
        email: true,
        nickname: true,
        tier: true,
        projectId: true,
        encryptedRefreshToken: true,
        createdAt: true,
      },
    });

    if (accounts.length === 0) {
      return NextResponse.json(
        { error: 'No accounts matched the selection.' },
        { status: 400 }
      );
    }

    // Build payload — decrypt each token for export
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: 'Multigravity Elysium',
      accounts: accounts.map((a) => ({
        email: a.email,
        nickname: a.nickname ?? null,
        tier: a.tier ?? null,
        projectId: a.projectId ?? null,
        refreshToken: decrypt(a.encryptedRefreshToken),
        originalCreatedAt: a.createdAt.toISOString(),
      })),
    };

    const plaintext = JSON.stringify(payload);

    // Derive key from password via scrypt
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 32);

    // Encrypt with AES-256-GCM
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: salt(16) | iv(12) | authTag(16) | ciphertext
    const bundle = Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');

    return NextResponse.json({ bundle });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[export] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
