// src/app/api/accounts/route.ts
// GET /api/accounts  — list all accounts (no tokens exposed)
// POST /api/accounts — not used for creation (OAuth handles that via /api/auth)

import { NextResponse } from 'next/server';
import { listAccounts } from '@/lib/database/accounts';
import { startScheduler } from '@/lib/scheduler';

// Start the background scheduler when any API route is first hit.
// This is idempotent — safe to call multiple times.
startScheduler();

export async function GET() {
  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch (err) {
    console.error('[GET /api/accounts]', err);
    return NextResponse.json({ error: 'Failed to list accounts' }, { status: 500 });
  }
}
