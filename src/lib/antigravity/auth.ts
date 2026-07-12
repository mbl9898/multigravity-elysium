// src/lib/antigravity/auth.ts
// Google OAuth 2.0 + PKCE authentication flow for Antigravity accounts.
// All calls happen server-side. Tokens are never exposed to the browser.
//
// References:
//   - wusimpl/AntigravityQuotaWatcher (src/auth/googleAuthService.ts) — PKCE flow
//   - Draculabo/AntigravityManager — token refresh pattern

import { randomBytes, createHash } from 'crypto';

// Base64 encoded fallbacks of the public Google Cloud Code native-app OAuth client
const FALLBACK_CLIENT_ID = 'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==';
const FALLBACK_CLIENT_SECRET = 'R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6cURBZg==';

export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ?? Buffer.from(FALLBACK_CLIENT_ID, 'base64').toString('utf8');

export const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET ?? Buffer.from(FALLBACK_CLIENT_SECRET, 'base64').toString('utf8');

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

// ─── PKCE Helpers ────────────────────────────────────────────────────────────

/** Generate a PKCE code_verifier (cryptographically random 43–128 char string). */
export function generateCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

/** Derive the PKCE code_challenge from a verifier (S256 method). */
export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ─── OAuth URL Builder ───────────────────────────────────────────────────────

export interface OAuthStartResult {
  url: string;
  codeVerifier: string;
  state: string;
}

/**
 * Build the Google OAuth authorization URL.
 * Returns the URL to redirect the user to, plus the state and code_verifier
 * that must be persisted (in an HTTP-only session cookie or server-side store)
 * until the callback arrives.
 */
export function buildAuthUrl(callbackUrl: string): OAuthStartResult {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString('hex'); // CSRF protection

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent', // ensures refresh_token is returned
    state,
  });

  return {
    url: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
    codeVerifier,
    state,
  };
}

// ─── Token Exchange ──────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Called once after the OAuth callback.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  callbackUrl: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: callbackUrl,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${err}`);
  }

  return response.json() as Promise<TokenResponse>;
}

// ─── Token Refresh ───────────────────────────────────────────────────────────

/**
 * Exchange a stored refresh_token for a fresh access_token.
 * Called before every Antigravity API request.
 * Returns ONLY the access_token — kept in-memory, never persisted.
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${err}`);
  }

  const data = (await response.json()) as TokenResponse;
  return data.access_token;
}

// ─── User Info ───────────────────────────────────────────────────────────────

export interface GoogleUserInfo {
  email: string;
  name?: string;
  picture?: string;
  sub: string;
}

/** Fetch the account's email address using a valid access token. */
export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info (${response.status})`);
  }

  return response.json() as Promise<GoogleUserInfo>;
}
