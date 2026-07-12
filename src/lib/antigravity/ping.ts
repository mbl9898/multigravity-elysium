// src/lib/antigravity/ping.ts
// Sends a minimal "ping" prompt to Gemini and Claude for a given account.
// Purpose: trigger the 5-hour countdown timer — it only starts on first use.
//
// Request format copied from weekly.ts (proven working):
//   - `project: projectId` MUST be at the top level of the body
//   - Headers: `requestType: 'agent'` + `requestId: <uuid>`
//   - Claude model: 'claude-sonnet-4-6'   (= "Claude Sonnet 4.6" in IDE)
//   - Gemini model: 'gemini-3.5-flash'    (= "Gemini 3.5 Flash" in IDE)

import { randomUUID } from 'crypto';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';

const PING_ENDPOINT =
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse';

/**
 * Gemini models to try in order.
 * 'gemini-3-flash' is the confirmed-working model for the cloudcode ping endpoint.
 */
const GEMINI_PING_MODELS = ['gemini-3-flash', 'gemini-3.5-flash'];

/** 'claude-sonnet-4-6' = "Claude Sonnet 4.6 (Thinking)" in the Antigravity IDE */
const CLAUDE_PING_MODEL = 'claude-sonnet-4-6';

/** 4 hours 59 minutes in milliseconds — ping threshold */
export const PING_INTERVAL_MS = (4 * 60 + 59) * 60 * 1000;

export interface PingResult {
  gemini: boolean;
  claude: boolean;
  geminiError?: string;
  claudeError?: string;
}

/**
 * Send a single minimal request to the cloudcode proxy for a given model.
 * Returns { ok: true } on 2xx or 429 (quota exceeded = countdown already running).
 */
async function pingModel(
  accessToken: string,
  modelId: string,
  projectId: string
): Promise<{ ok: boolean; error?: string }> {
  const body = JSON.stringify({
    model: modelId,
    project: projectId, // Required: tells cloudcode which GCP project to bill
    request: {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
    },
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/1.11.3 windows/amd64',
    requestId: randomUUID(),
    requestType: 'agent',
  };

  try {
    const res = await fetch(PING_ENDPOINT, { method: 'POST', headers, body });
    if (res.ok) return { ok: true };
    // 429 = quota exceeded — countdown already running, treat as success
    if (res.status === 429) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Try each Gemini model in GEMINI_PING_MODELS order.
 * Falls back to the next model on 404; stops on hard auth errors.
 */
async function pingGemini(
  accessToken: string,
  projectId: string
): Promise<{ ok: boolean; modelUsed?: string; error?: string }> {
  for (const modelId of GEMINI_PING_MODELS) {
    const result = await pingModel(accessToken, modelId, projectId);
    if (result.ok) return { ok: true, modelUsed: modelId };
    // Hard auth/server error — don't bother with next model
    if (result.error && !result.error.includes('404')) {
      return { ok: false, error: result.error };
    }
  }
  return {
    ok: false,
    error: `All Gemini models failed (404): ${GEMINI_PING_MODELS.join(', ')}`,
  };
}

/**
 * Ping both Gemini and Claude for a given account.
 * Updates lastPingAt, lastPingStatus, lastPingError in the database.
 */
export async function pingAccount(accountId: string): Promise<PingResult> {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      email: true,
      encryptedRefreshToken: true,
      projectId: true,
    },
  });

  if (!row) throw new Error(`Account ${accountId} not found`);
  if (!row.projectId)
    throw new Error(
      `Account ${accountId} has no projectId — run a quota refresh first`
    );

  const refreshToken = decrypt(row.encryptedRefreshToken);
  const accessToken = await refreshAccessToken(refreshToken);

  const [geminiResult, claudeResult] = await Promise.allSettled([
    pingGemini(accessToken, row.projectId),
    pingModel(accessToken, CLAUDE_PING_MODEL, row.projectId),
  ]);

  const gemini =
    geminiResult.status === 'fulfilled' ? geminiResult.value.ok : false;
  const claude =
    claudeResult.status === 'fulfilled' ? claudeResult.value.ok : false;

  const geminiError =
    geminiResult.status === 'rejected'
      ? String(geminiResult.reason)
      : (geminiResult.value as { ok: boolean; error?: string }).error;
  const claudeError =
    claudeResult.status === 'rejected'
      ? String(claudeResult.reason)
      : claudeResult.value.error;

  const geminiModel =
    geminiResult.status === 'fulfilled'
      ? (geminiResult.value as { ok: boolean; modelUsed?: string }).modelUsed
      : undefined;

  const status =
    gemini && claude ? 'success' : gemini || claude ? 'partial' : 'error';
  const errorMsg =
    [geminiError, claudeError].filter(Boolean).join(' | ') || null;

  await prisma.account.update({
    where: { id: accountId },
    data: {
      lastPingAt: status !== 'error' ? new Date() : undefined,
      lastPingStatus: status,
      lastPingError: errorMsg,
    },
  });

  console.log(
    `[ping] ${row.email} → gemini=${gemini}${geminiModel ? ` (${geminiModel})` : ''} claude=${claude} status=${status}${
      errorMsg ? ` error=${errorMsg}` : ''
    }`
  );

  return { gemini, claude, geminiError, claudeError };
}

/**
 * Returns true if the account needs a ping:
 * - lastPingAt is null (never pinged), OR
 * - more than 4h59m has passed since the last ping
 */
export function needsPing(lastPingAt: Date | null): boolean {
  if (!lastPingAt) return true;
  return Date.now() - lastPingAt.getTime() >= PING_INTERVAL_MS;
}
