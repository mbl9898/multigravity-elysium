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

import https from 'https';
import dns from 'dns';

// Resolve real IP of target host using Cloudflare/Google DNS to bypass local /etc/hosts redirect
function resolveRealIp(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    resolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses.length) return reject(err || new Error('No IP found'));
      resolve(addresses[0]);
    });
  });
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
    Host: 'cloudcode-pa.googleapis.com',
  };

  try {
    const realIp = await resolveRealIp('cloudcode-pa.googleapis.com');

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: realIp,
          port: 443,
          path: '/v1internal:streamGenerateContent?alt=sse',
          method: 'POST',
          headers,
          servername: 'cloudcode-pa.googleapis.com',
          rejectUnauthorized: false,
        },
        (res) => {
          let resBody = '';
          res.on('data', (chunk) => (resBody += chunk));
          res.on('end', () => {
            const status = res.statusCode || 500;
            if (status >= 200 && status < 300) {
              resolve({ ok: true });
            } else if (status === 429) {
              resolve({ ok: true }); // quota exceeded countdown running
            } else {
              resolve({ ok: false, error: `HTTP ${status}: ${resBody.slice(0, 300)}` });
            }
          });
        }
      );

      req.on('error', (err) => {
        resolve({ ok: false, error: `Socket error: ${err.message}` });
      });

      req.write(body);
      req.end();
    });
  } catch (err) {
    return { ok: false, error: `DNS resolve error: ${String(err)}` };
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
