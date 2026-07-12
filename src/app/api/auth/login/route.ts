// src/app/api/auth/login/route.ts
// GET /api/auth/login
// Starts the OAuth PKCE flow:
//   1. Generates code_verifier + state
//   2. Stores them in the OAuthSession table (expires after use)
//   3. Redirects the browser to Google's authorization URL

import { NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/antigravity/auth';
import { prisma } from '@/lib/database/client';

export async function GET() {
  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/auth/callback`;

  const { url, codeVerifier, state } = buildAuthUrl(callbackUrl);

  // Store the PKCE state in the DB (temporary — deleted after callback)
  await prisma.oAuthSession.create({
    data: { state, codeVerifier },
  });

  // Clean up stale sessions older than 10 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  await prisma.oAuthSession.deleteMany({
    where: { createdAt: { lt: tenMinutesAgo } },
  });

  return NextResponse.redirect(url);
}
