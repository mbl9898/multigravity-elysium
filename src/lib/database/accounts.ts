// src/lib/database/accounts.ts
// Database operations for accounts — all token handling goes through encryption.
// This is the ONLY place that reads/writes the encryptedRefreshToken column.

import { prisma } from './client';
import { encrypt, decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';
import { loadCodeAssist, fetchAccountQuota } from '@/lib/antigravity/quota';
import type { Account, AccountHealth, AccountQuota, PoolQuota } from '@/types';

// ─── Serialization helpers ────────────────────────────────────────────────────

export function parseQuotaJson(json: string | null | undefined): AccountQuota | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as AccountQuota;
  } catch {
    return null;
  }
}

function deriveHealth(db: {
  isHealthy: boolean;
  lastError: string | null;
  encryptedRefreshToken: string;
}): AccountHealth {
  if (!db.encryptedRefreshToken) return 'unauthenticated';
  if (!db.isHealthy) return 'error';
  if (db.lastError) return 'degraded';
  return 'healthy';
}

function toAccount(db: {
  id: string;
  email: string;
  nickname: string | null;
  tier: string | null;
  quotaJson: string | null;
  lastChecked: Date | null;
  lastError: string | null;
  isHealthy: boolean;
  encryptedRefreshToken: string;
  createdAt: Date;
  lastPingAt: Date | null;
  lastPingStatus: string | null;
  lastPingError: string | null;
}): Account {
  return {
    id: db.id,
    email: db.email,
    nickname: db.nickname,
    tier: db.tier,
    quota: parseQuotaJson(db.quotaJson),
    lastChecked: db.lastChecked?.toISOString() ?? null,
    lastError: db.lastError,
    health: deriveHealth(db),
    createdAt: db.createdAt.toISOString(),
    lastPingAt: db.lastPingAt?.toISOString() ?? null,
    lastPingStatus: db.lastPingStatus,
    lastPingError: db.lastPingError,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listAccounts(): Promise<Account[]> {
  const rows = await prisma.account.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toAccount);
}

export async function getAccount(id: string): Promise<Account | null> {
  const row = await prisma.account.findUnique({ where: { id } });
  return row ? toAccount(row) : null;
}

export async function createAccount(
  email: string,
  refreshToken: string,
  tier?: string | null,
  projectId?: string | null
): Promise<Account> {
  const row = await prisma.account.create({
    data: {
      email,
      encryptedRefreshToken: encrypt(refreshToken),
      tier,
      projectId,
    },
  });
  return toAccount(row);
}

export async function updateAccountNickname(id: string, nickname: string): Promise<void> {
  await prisma.account.update({ where: { id }, data: { nickname } });
}

export async function deleteAccount(id: string): Promise<void> {
  await prisma.account.delete({ where: { id } });
}

// ─── Quota update ─────────────────────────────────────────────────────────────

/**
 * Stores updated quota data for an account.
 * Preserves existing weekly data — only the 5h fields come from the API automatically.
 */
export async function updateAccountQuota(
  id: string,
  newQuota: AccountQuota,
  options?: { mergeWeekly?: boolean }
): Promise<void> {
  let quotaToStore = newQuota;

  // If merging, preserve any existing weekly data
  if (options?.mergeWeekly) {
    const existing = await prisma.account.findUnique({
      where: { id },
      select: { quotaJson: true },
    });
    const existingQuota = parseQuotaJson(existing?.quotaJson);
    if (existingQuota) {
      quotaToStore = mergeQuotaData(newQuota, existingQuota);
    }
  }

  await prisma.account.update({
    where: { id },
    data: {
      quotaJson: JSON.stringify(quotaToStore),
      lastChecked: new Date(),
      lastError: null,
      isHealthy: true,
    },
  });
}

export async function updateAccountError(id: string, error: string): Promise<void> {
  await prisma.account.update({
    where: { id },
    data: { lastError: error, isHealthy: false },
  });
}

export async function updateAccountWeeklyQuota(
  id: string,
  pool: 'gemini' | 'anthropic',
  poolQuota: PoolQuota
): Promise<void> {
  const existing = await prisma.account.findUnique({
    where: { id },
    select: { quotaJson: true },
  });
  const existingQuota = parseQuotaJson(existing?.quotaJson) ?? {
    gemini: { remaining5h: null, resetTime5h: null, remaining7d: null, resetTime7d: null, weeklyStatus: 'unknown' as const },
    anthropic: { remaining5h: null, resetTime5h: null, remaining7d: null, resetTime7d: null, weeklyStatus: 'unknown' as const },
  };

  const updated: AccountQuota = {
    ...existingQuota,
    [pool]: poolQuota,
  };

  await prisma.account.update({
    where: { id },
    data: { quotaJson: JSON.stringify(updated) },
  });
}

/** Merges fresh and existing quota data, preserving previous values when fresh values are unknown/null. */
function mergeQuotaData(fresh: AccountQuota, existing: AccountQuota): AccountQuota {
  return {
    gemini: {
      remaining5h: fresh.gemini.remaining5h !== null ? fresh.gemini.remaining5h : existing.gemini.remaining5h,
      resetTime5h: fresh.gemini.remaining5h !== null ? fresh.gemini.resetTime5h : existing.gemini.resetTime5h,
      remaining7d: fresh.gemini.weeklyStatus === 'unknown' ? existing.gemini.remaining7d : fresh.gemini.remaining7d,
      resetTime7d: fresh.gemini.weeklyStatus === 'unknown' ? existing.gemini.resetTime7d : fresh.gemini.resetTime7d,
      weeklyStatus: fresh.gemini.weeklyStatus === 'unknown' ? existing.gemini.weeklyStatus : fresh.gemini.weeklyStatus,
      lastWeeklyChecked: fresh.gemini.weeklyStatus === 'unknown' ? existing.gemini.lastWeeklyChecked : fresh.gemini.lastWeeklyChecked,
    },
    anthropic: {
      remaining5h: fresh.anthropic.remaining5h !== null ? fresh.anthropic.remaining5h : existing.anthropic.remaining5h,
      resetTime5h: fresh.anthropic.remaining5h !== null ? fresh.anthropic.resetTime5h : existing.anthropic.resetTime5h,
      remaining7d: fresh.anthropic.weeklyStatus === 'unknown' ? existing.anthropic.remaining7d : fresh.anthropic.remaining7d,
      resetTime7d: fresh.anthropic.weeklyStatus === 'unknown' ? existing.anthropic.resetTime7d : fresh.anthropic.resetTime7d,
      weeklyStatus: fresh.anthropic.weeklyStatus === 'unknown' ? existing.anthropic.weeklyStatus : fresh.anthropic.weeklyStatus,
      lastWeeklyChecked: fresh.anthropic.weeklyStatus === 'unknown' ? existing.anthropic.lastWeeklyChecked : fresh.anthropic.lastWeeklyChecked,
    },
  };
}

// ─── Quota refresh for one account ───────────────────────────────────────────

/**
 * Full quota refresh pipeline for one account:
 *   1. Decrypt refresh token
 *   2. Get fresh access token
 *   3. loadCodeAssist → projectId + tier
 *   4. fetchAvailableModels → classify → normalize
 *   5. Store in DB (preserving existing weekly data)
 *
 * All errors are caught and recorded in the DB without throwing.
 */
export async function refreshQuotaForAccount(
  accountId: string,
  localResults?: Array<{ email: string; quota: AccountQuota }>
): Promise<void> {
  let row: {
    id: string;
    email: string;
    encryptedRefreshToken: string;
    projectId: string | null;
    tier: string | null;
    quotaJson: string | null;
    lastPingAt: Date | null;
  } | null;

  try {
    row = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        email: true,
        encryptedRefreshToken: true,
        projectId: true,
        tier: true,
        quotaJson: true,
        lastPingAt: true,
      },
    });
  } catch (err) {
    console.error(`[scheduler] DB error for account ${accountId}:`, err);
    return;
  }

  if (!row) return;

  // 1. Perform the remote refresh
  try {
    const refreshToken = decrypt(row.encryptedRefreshToken);
    const accessToken = await refreshAccessToken(refreshToken);

    let { projectId, tier } = row;
    if (!projectId) {
      const result = await loadCodeAssist(accessToken);
      projectId = result.projectId;
      tier = result.tier;
      await prisma.account.update({
        where: { id: accountId },
        data: { projectId, tier },
      });
    }

    // Fetch the quota remotely (fractions + weekly limits)
    let quota = await fetchAccountQuota(accessToken, projectId);

    // ─── Fix resetTime5h ───────────────────────────────────────────────────
    // The retrieveUserQuotaSummary API always returns resetTime = "now + 5h"
    // on every call — it is NOT the actual window expiry. This causes the
    // countdown to appear frozen at ~5h after every 60s refresh.
    //
    // Instead, we derive resetTime5h from lastPingAt (when we triggered the
    // window). If the window has since expired, we clear it to null.
    const pingExpiry = row.lastPingAt
      ? new Date(new Date(row.lastPingAt).getTime() + 5 * 60 * 60 * 1000)
      : null;
    const windowOpen = pingExpiry && pingExpiry > new Date();

    quota.gemini.resetTime5h = windowOpen ? pingExpiry!.toISOString() : null;
    quota.anthropic.resetTime5h = windowOpen ? pingExpiry!.toISOString() : null;
    // ──────────────────────────────────────────────────────────────────────

    // Merge existing quota first (preserve weekly data we've already computed)
    const existingQuota = parseQuotaJson(row.quotaJson);
    if (existingQuota) {
      quota = mergeQuotaData(quota, existingQuota);
    }

    // Apply local LS data on top — it has the real IDE-tracked resetTime5h
    // (e.g. the V2-active account shows the true window from the language server)
    const emailLower = row.email.toLowerCase().trim();
    const localMatch = localResults?.find((r) => r.email === emailLower);
    if (localMatch) {
      // Local LS overrides resetTime5h and remaining5h since it's most accurate
      if (localMatch.quota.gemini.resetTime5h) {
        quota.gemini.resetTime5h = localMatch.quota.gemini.resetTime5h;
      }
      if (localMatch.quota.anthropic.resetTime5h) {
        quota.anthropic.resetTime5h = localMatch.quota.anthropic.resetTime5h;
      }
      if (localMatch.quota.gemini.remaining5h !== null) {
        quota.gemini.remaining5h = localMatch.quota.gemini.remaining5h;
      }
      if (localMatch.quota.anthropic.remaining5h !== null) {
        quota.anthropic.remaining5h = localMatch.quota.anthropic.remaining5h;
      }
    }

    quota.gemini.lastWeeklyChecked = new Date().toISOString();
    quota.anthropic.lastWeeklyChecked = new Date().toISOString();
    await updateAccountQuota(accountId, quota, { mergeWeekly: false });
  } catch (err) {
    // Fallback: If remote refresh fails, check if we have a local LS result we can use
    if (localResults && localResults.length > 0) {
      const emailLower = row.email.toLowerCase().trim();
      const localMatch = localResults.find((r) => r.email === emailLower);
      if (localMatch) {
        console.log(`[scheduler] Remote refresh failed for ${row.email}, falling back to local LS:`, err);
        const existingQuota = parseQuotaJson(row.quotaJson);
        let quota = localMatch.quota;
        if (existingQuota) {
          quota = mergeQuotaData(quota, existingQuota);
        }
        await updateAccountQuota(row.id, quota, { mergeWeekly: false });
        return;
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Quota refresh failed for account ${accountId}: ${message}`);
    await updateAccountError(accountId, message);
  }
}
