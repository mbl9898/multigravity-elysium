// src/lib/scheduler/index.ts
// Background quota refresh scheduler.
// Runs as an in-process singleton in the Next.js server (not in the browser).
// Refreshes all account quotas every 60 seconds.
//
// In development: starts automatically when Next.js dev server starts.
// In production: PM2 keeps the process alive, so the scheduler keeps running.

import { prisma } from '@/lib/database/client';
import { refreshQuotaForAccount } from '@/lib/database/accounts';
import { scanLocalLanguageServers } from '@/lib/antigravity/local_ls';
import { pingAccount, needsPing } from '@/lib/antigravity/ping';

// Prevent duplicate interval handles under Next.js Hot Module Replacement (HMR)
const globalScheduler = globalThis as typeof globalThis & {
  __schedulerHandle__?: NodeJS.Timeout | null;
  __schedulerRunning__?: boolean;
};

const POLL_INTERVAL_MS = 60_000; // 60 seconds

/**
 * Refresh quotas for ALL accounts concurrently.
 * Each account is independent — one failure doesn't stop others.
 */
async function runRefreshCycle(): Promise<void> {
  if (globalScheduler.__schedulerRunning__) {
    // Previous cycle still running — skip this tick to avoid overlap
    return;
  }
  globalScheduler.__schedulerRunning__ = true;

  try {
    const accounts = await prisma.account.findMany({
      select: { id: true },
    });

    if (accounts.length === 0) return;

    // Discover any running local language servers first
    const localResults = await scanLocalLanguageServers().catch((err) => {
      console.error('[scheduler] Local LS scan failed:', err);
      return [];
    });

    // All accounts refresh concurrently
    await Promise.allSettled(
      accounts.map((acc) => refreshQuotaForAccount(acc.id, localResults))
    );

    // ── Auto-ping: trigger 5h countdown for accounts that need it ──────────────
    const accountsWithPing = await prisma.account.findMany({
      select: { id: true, lastPingAt: true },
    });

    const toPing = accountsWithPing.filter((acc) => needsPing(acc.lastPingAt));

    if (toPing.length > 0) {
      console.log(`[scheduler] Auto-pinging ${toPing.length} account(s) to trigger 5h countdown...`);
      await Promise.allSettled(
        toPing.map((acc) =>
          pingAccount(acc.id).catch((err) =>
            console.error(`[scheduler] Ping failed for ${acc.id}:`, err)
          )
        )
      );
    }
  } catch (err) {
    console.error('[scheduler] Error in refresh cycle:', err);
  } finally {
    globalScheduler.__schedulerRunning__ = false;
  }
}

/**
 * Start the background scheduler.
 * Safe to call multiple times — only starts once (idempotent).
 */
export function startScheduler(): void {
  if (globalScheduler.__schedulerHandle__) return;

  console.log(`[scheduler] Starting quota refresh (interval: ${POLL_INTERVAL_MS / 1000}s)`);

  // Run immediately on start, then on interval
  void runRefreshCycle();
  globalScheduler.__schedulerHandle__ = setInterval(() => {
    void runRefreshCycle();
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the scheduler (for clean shutdown — rarely needed).
 */
export function stopScheduler(): void {
  if (globalScheduler.__schedulerHandle__) {
    clearInterval(globalScheduler.__schedulerHandle__);
    globalScheduler.__schedulerHandle__ = null;
    console.log('[scheduler] Stopped.');
  }
}

/**
 * Trigger an immediate refresh for a single account outside the normal cycle.
 * Used by the "Refresh now" button on account cards.
 */
export async function refreshNow(accountId: string): Promise<void> {
  const localResults = await scanLocalLanguageServers().catch(() => []);
  await refreshQuotaForAccount(accountId, localResults);
}
