// src/app/api/accounts/[id]/route.ts
// DELETE /api/accounts/[id]  — remove account and its stored token
// PATCH  /api/accounts/[id]  — update nickname

import { NextRequest, NextResponse } from 'next/server';
import { deleteAccount, updateAccountNickname } from '@/lib/database/accounts';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await deleteAccount(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[DELETE /api/accounts/${id}]`, err);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { nickname?: string };
    if (typeof body.nickname !== 'string') {
      return NextResponse.json({ error: 'nickname is required' }, { status: 400 });
    }
    await updateAccountNickname(id, body.nickname);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[PATCH /api/accounts/${id}]`, err);
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
  }
}
