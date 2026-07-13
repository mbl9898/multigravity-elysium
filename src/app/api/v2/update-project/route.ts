// src/app/api/v2/update-project/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/database/client';

export async function POST(req: NextRequest) {
  try {
    const { accessToken, projectId } = await req.json();
    if (!accessToken || !projectId) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Resolve email from Google userinfo endpoint
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch userinfo from Google' }, { status: 400 });
    }

    const userInfo = await response.json();
    const email = userInfo.email;

    if (!email) {
      return NextResponse.json({ error: 'No email found in userinfo response' }, { status: 400 });
    }

    // Find account and update project ID
    const account = await prisma.account.findFirst({
      where: { email },
    });

    if (account) {
      if (account.projectId !== projectId) {
        console.log(`[Auto-Learn] Swapping project ID for ${email}: ${account.projectId || 'NULL'} -> ${projectId}`);
        await prisma.account.update({
          where: { id: account.id },
          data: {
            projectId,
            lastError: null,
            isHealthy: true
          },
        });
      }
      return NextResponse.json({ success: true, email, projectId });
    }

    return NextResponse.json({ error: 'Account not found in database' }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
