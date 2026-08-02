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


/**
 * Gemini models to try in order.
 * 'gemini-2.5-flash-lite' = the exact model the Antigravity IDE uses for real requests,
 * confirmed by MITM proxy log: "[MITM PROXY] Intercepted request. Model: gemini-2.5-flash-lite"
 * This ensures the ping bills against the same "Gemini Models" 5h quota pool that the IDE tracks.
 */
const GEMINI_PING_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-low', 'gemini-3-flash'];

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

import https from 'https';

// Candidate backends to ping in parallel to ensure complete coverage.
const PING_HOSTS: Array<{ host: string; ip?: string }> = [
  { host: 'daily-cloudcode-pa.googleapis.com', ip: '34.54.84.110' },
  { host: 'daily-cloudcode-pa.googleapis.com' },
  { host: 'daily-cloudcode-pa.sandbox.googleapis.com' },
  { host: 'antigravity-unleash.goog', ip: '34.54.84.110' },
];

function pingModelOnHost(
  accessToken: string,
  modelId: string,
  projectId: string,
  hostCfg: { host: string; ip?: string }
): Promise<{ ok: boolean; error?: string }> {
  const { host, ip } = hostCfg;
  const body = JSON.stringify({
    model: modelId,
    project: projectId,
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Ping' }] }],
      generationConfig: { maxOutputTokens: 10, temperature: 0.1 },
    },
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/1.11.3 windows/amd64',
    requestId: randomUUID(),
    requestType: 'agent',
    Host: host,
  };

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: ip || host,
        port: 443,
        path: '/v1internal:streamGenerateContent?alt=sse',
        method: 'POST',
        headers,
        servername: host,
        rejectUnauthorized: false,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          const status = res.statusCode || 500;
          if (status >= 200 && status < 300) {
            console.log(`[ping] ✓ ${host}${ip ? ` (${ip})` : ''} → ${modelId} → HTTP ${status}`);
            resolve({ ok: true });
          } else if (status === 429) {
            console.log(`[ping] ✓ ${host}${ip ? ` (${ip})` : ''} → ${modelId} → HTTP 429 (quota active)`);
            resolve({ ok: true });
          } else {
            console.log(`[ping] ✗ ${host}${ip ? ` (${ip})` : ''} → ${modelId} → HTTP ${status}`);
            resolve({ ok: false, error: `HTTP ${status}: ${resBody.slice(0, 300)}` });
          }
        });
      }
    );

    req.on('error', (err) => {
      console.log(`[ping] ✗ ${host}${ip ? ` (${ip})` : ''} → ${modelId} → Socket error: ${err.message}`);
      resolve({ ok: false, error: `Socket error: ${err.message}` });
    });

    req.write(body);
    req.end();
  });
}

async function pingModel(
  accessToken: string,
  modelId: string,
  projectId: string
): Promise<{ ok: boolean; error?: string }> {
  const results = await Promise.allSettled(
    PING_HOSTS.map(cfg => pingModelOnHost(accessToken, modelId, projectId, cfg))
  );

  let anyOk = false;
  let lastError: string | undefined;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) anyOk = true;
    if (r.status === 'fulfilled' && r.value.error) lastError = r.value.error;
    if (r.status === 'rejected') lastError = String(r.reason);
  }

  return { ok: anyOk, error: anyOk ? undefined : lastError };
}

async function pingGemini(
  accessToken: string,
  projectId: string
): Promise<{ ok: boolean; modelUsed?: string; error?: string }> {
  for (const modelId of GEMINI_PING_MODELS) {
    const result = await pingModel(accessToken, modelId, projectId);
    if (result.ok) return { ok: true, modelUsed: modelId };
    if (result.error && !result.error.includes('404')) {
      return { ok: false, error: result.error };
    }
  }
  return {
    ok: false,
    error: `All Gemini models failed (404): ${GEMINI_PING_MODELS.join(', ')}`,
  };
}

export async function pingAccount(
  accountId: string,
  options?: { pingGemini?: boolean; pingClaude?: boolean }
): Promise<PingResult> {
  const runGemini = options?.pingGemini ?? true;
  const runClaude = options?.pingClaude ?? true;

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
    runGemini
      ? pingGemini(accessToken, row.projectId)
      : Promise.resolve({ ok: true, modelUsed: 'skipped', error: undefined as string | undefined }),
    runClaude
      ? pingModel(accessToken, CLAUDE_PING_MODEL, row.projectId)
      : Promise.resolve({ ok: true, error: undefined as string | undefined }),
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

  const actualGemini = runGemini ? gemini : true;
  const actualClaude = runClaude ? claude : true;

  const status =
    actualGemini && actualClaude ? 'success' : actualGemini || actualClaude ? 'partial' : 'error';
  const errorMsg =
    [geminiError, claudeError].filter((e) => e && e !== 'Skipped').join(' | ') || null;

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

  if (gemini && row.projectId) {
    try {
      const { fetchAccountQuota } = await import('./quota');
      const q = await fetchAccountQuota(accessToken, row.projectId);
      const g5h = q.gemini?.remaining5h;
      const g5hReset = q.gemini?.resetTime5h;
      console.log(
        `[ping] ${row.email} → post-ping quota: gemini.remaining5h=${g5h ?? 'null'} resetTime5h=${g5hReset ?? 'null'}`
      );
    } catch (qErr) {
      console.log(`[ping] ${row.email} → post-ping quota check failed: ${qErr}`);
    }
  }

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
