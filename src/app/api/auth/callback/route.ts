// src/app/api/auth/callback/route.ts
// GET /api/auth/callback?code=...&state=...
// Handles the OAuth redirect from Google:
//   1. Validates state (CSRF protection)
//   2. Exchanges auth code for tokens using the stored code_verifier
//   3. Fetches user info (email)
//   4. Stores encrypted refresh token in DB
//   5. Triggers initial quota fetch
//   6. Redirects back to dashboard

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, fetchUserInfo } from '@/lib/antigravity/auth';
import { prisma } from '@/lib/database/client';
import { createAccount, refreshQuotaForAccount } from '@/lib/database/accounts';

const DASHBOARD_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // User denied access
  if (error) {
    return NextResponse.redirect(`${DASHBOARD_URL}?error=access_denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${DASHBOARD_URL}?error=invalid_callback`);
  }

  // Look up the stored PKCE session
  const session = await prisma.oAuthSession.findUnique({ where: { state } });
  if (!session) {
    return NextResponse.redirect(`${DASHBOARD_URL}?error=invalid_state`);
  }

  // Delete the session immediately (one-time use)
  await prisma.oAuthSession.delete({ where: { state } });

  const callbackUrl = `${DASHBOARD_URL}/api/auth/callback`;

  try {
    // Exchange auth code for tokens
    const tokens = await exchangeCodeForTokens(code, session.codeVerifier, callbackUrl);

    if (!tokens.refresh_token) {
      return NextResponse.redirect(`${DASHBOARD_URL}?error=no_refresh_token`);
    }

    // Fetch user info (email)
    const userInfo = await fetchUserInfo(tokens.access_token);

    // Create the account (stores encrypted refresh token).
    // tier and projectId start null — the background job fills them in on first refresh.
    const account = await createAccount(userInfo.email, tokens.refresh_token, null, null);

    // Trigger initial quota fetch in the background (don't wait — don't block the redirect)
    void refreshQuotaForAccount(account.id);

    return NextResponse.redirect(`${DASHBOARD_URL}?added=${encodeURIComponent(userInfo.email)}`);
  } catch (err) {
    console.error('[OAuth callback error]', err instanceof Error ? err.message : err);
    return NextResponse.redirect(`${DASHBOARD_URL}?error=auth_failed`);
  }
}
