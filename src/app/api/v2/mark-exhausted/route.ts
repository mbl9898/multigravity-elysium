// src/app/api/v2/mark-exhausted/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { markExhausted } from '@/lib/router/accountRouter';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get('accountId');
    const pool = searchParams.get('pool') as 'gemini' | 'anthropic';

    if (!accountId || !pool) {
      return NextResponse.json({ error: 'Missing accountId or pool parameter' }, { status: 400 });
    }

    await markExhausted(accountId, pool);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
