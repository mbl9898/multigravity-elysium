// src/app/api/quota/[accountId]/route.ts
// GET  /api/quota/[accountId]        — return latest cached quota from DB
// POST /api/quota/[accountId]/refresh — force immediate quota refresh

import { NextRequest, NextResponse } from 'next/server';
import { getAccount } from '@/lib/database/accounts';
import { refreshNow } from '@/lib/scheduler';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;
  try {
    const account = await getAccount(accountId);
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    return NextResponse.json({ account });
  } catch (err) {
    console.error(`[GET /api/quota/${accountId}]`, err);
    return NextResponse.json({ error: 'Failed to get quota' }, { status: 500 });
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;
  try {
    await refreshNow(accountId);
    const account = await getAccount(accountId);
    return NextResponse.json({ account });
  } catch (err) {
    console.error(`[POST /api/quota/${accountId}]`, err);
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 });
  }
}
