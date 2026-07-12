// src/app/api/quota/[accountId]/weekly/route.ts
// POST /api/quota/[accountId]/weekly
// Triggers the manual weekly quota probe for a specific pool.
// ⚠️  This consumes real quota — only called on explicit user action.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';
import { checkWeeklyQuota, applyWeeklyResult } from '@/lib/antigravity/weekly';
import { getAccount, updateAccountWeeklyQuota } from '@/lib/database/accounts';
import { v4 as uuidv4 } from 'uuid';
import type { QuotaPool, PoolQuota } from '@/types';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;

  const body = (await req.json().catch(() => ({}))) as { pool?: string };
  const pool = body.pool as QuotaPool | undefined;

  if (pool !== 'gemini' && pool !== 'anthropic') {
    return NextResponse.json(
      { error: 'pool must be "gemini" or "anthropic"' },
      { status: 400 }
    );
  }

  // Load account
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: { encryptedRefreshToken: true, quotaJson: true, projectId: true },
  });

  if (!row) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  try {
    const refreshToken = decrypt(row.encryptedRefreshToken);
    const accessToken = await refreshAccessToken(refreshToken);

    const projectId = row.projectId || 'eastern-coda-9zvhp';
    const result = await checkWeeklyQuota(accessToken, pool, projectId, uuidv4());

    // Get existing pool quota to merge into
    const account = await getAccount(accountId);
    const existingPool: PoolQuota = account?.quota?.[pool] ?? {
      remaining5h: null,
      resetTime5h: null,
      remaining7d: null,
      resetTime7d: null,
      weeklyStatus: 'unknown',
    };

    const updatedPool = applyWeeklyResult(existingPool, result);
    await updateAccountWeeklyQuota(accountId, pool, updatedPool);

    return NextResponse.json({
      result: result.type,
      pool,
      quota: updatedPool,
      ...(result.type === 'weekly_exhausted' && {
        resetTime: result.resetTime,
        resetDelayHours: result.resetDelayHours,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[POST /api/quota/${accountId}/weekly]`, message);
    return NextResponse.json({ error: 'Weekly check failed', detail: message }, { status: 500 });
  }
}
