// src/app/api/v2/get-token/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { selectAndLockAccount, releaseAccount } from '@/lib/router/accountRouter';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const model = searchParams.get('model') || 'gemini-3-flash';
    const pool = model.toLowerCase().includes('claude') ? 'anthropic' : 'gemini';

    // Select a healthy, non-exhausted account from the pool
    const res = await selectAndLockAccount(pool);
    try {
      const account = await prisma.account.findUnique({
        where: { id: res.accountId },
        select: { id: true, email: true, encryptedRefreshToken: true, projectId: true },
      });

      if (!account) {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
      }

      const decrypted = decrypt(account.encryptedRefreshToken);
      const accessToken = await refreshAccessToken(decrypted);

      return NextResponse.json({
        accessToken,
        email: account.email,
        accountId: account.id,
        projectId: account.projectId,
        pool,
      });
    } finally {
      // Release lock
      releaseAccount(res.accountId);
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
