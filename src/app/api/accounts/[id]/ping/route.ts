// src/app/api/accounts/[id]/ping/route.ts
// POST /api/accounts/:id/ping — manually trigger a ping for a specific account.
// GET  /api/accounts/:id/ping — return the account's current ping status.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/database/client';
import { pingAccount } from '@/lib/antigravity/ping';
import { refreshNow } from '@/lib/scheduler';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const row = await prisma.account.findUnique({
    where: { id },
    select: { lastPingAt: true, lastPingStatus: true, lastPingError: true },
  });

  if (!row) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  return NextResponse.json({
    lastPingAt: row.lastPingAt?.toISOString() ?? null,
    lastPingStatus: row.lastPingStatus,
    lastPingError: row.lastPingError,
  });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const result = await pingAccount(id);

    // Immediately refresh quota so the countdown timer appears on the card
    // without waiting for the next 60s scheduler cycle.
    void refreshNow(id).catch((err) =>
      console.error(`[ping route] Post-ping quota refresh failed for ${id}:`, err)
    );

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[POST /api/accounts/${id}/ping]`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
