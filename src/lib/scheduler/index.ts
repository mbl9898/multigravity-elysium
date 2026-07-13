// src/lib/scheduler/index.ts
// Background quota refresh scheduler.
// Runs as an in-process singleton in the Next.js server (not in the browser).
// Refreshes all account quotas every 60 seconds.
//
// In development: starts automatically when Next.js dev server starts.
// In production: PM2 keeps the process alive, so the scheduler keeps running.
//
// NOTE: local_ls (MITM-dependent) is intentionally NOT used here.
// All quota data comes from the remote Google API directly via ping.ts DNS bypass.

import { prisma } from '@/lib/database/client';
import { refreshQuotaForAccount, parseQuotaJson } from '@/lib/database/accounts';
import { pingAccount } from '@/lib/antigravity/ping';
// preWarmTokenCache is part of the router feature (separate module).
// Path is intentionally kept in a variable so tsc does not try to resolve it
// at compile time — the module will be available at runtime once deployed.
async function preWarmTokenCache(): Promise<void> {
  try {
    const routerPath = '@/lib/router/accountRouter';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ routerPath).catch(() => null);
    if (typeof mod?.preWarmTokenCache === 'function') await mod.preWarmTokenCache();
  } catch {
    // router module not yet available — skip silently
  }
}

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

    // NOTE: local_ls is NOT used — it relies on MITM proxy data.
    // All quota data comes directly from the remote Google API.
    await Promise.allSettled(
      accounts.map((acc) => refreshQuotaForAccount(acc.id, []))
    );

    // ── Auto-ping: trigger 5h countdown for accounts that need it ──────────────
    //
    // TIMER ACTIVE DEFINITION:
    //   A 5h timer is considered "truly active" only when ALL of the following:
    //     (a) resetTime5h is in the future, AND
    //     (b) pingStillValid OR remaining5h < 0.9999
    //
    // pingStillValid:
    //   lastPingAt is only trusted as a "window started" signal if it occurred
    //   within the last 5 hours. Once 5h pass, the previous ping is stale and
    //   the account needs a fresh ping to start its next window.
    //
    //   Why this matters:
    //   After a 5h window expires, the quota refresh runs BEFORE the ping check.
    //   The remote API returns a new placeholder resetTime5h = now+5h (fake).
    //   Without expiry, hasPinged=true + resetFuture=true → timerActive=true →
    //   the scheduler skips the re-ping forever. By expiring pingStillValid after
    //   5h, the stale lastPingAt no longer suppresses the next window's ping.
    //
    // remaining5h < 0.9999 fallback:
    //   Catches accounts where lastPingAt is missing/cleared but real consumption
    //   is already visible in the fraction (e.g. active IDE usage on the account).
    //
    // The 5h window constant matches Google's 5-hour quota reset period exactly.
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

    const accountsWithPing = await prisma.account.findMany({
      select: { id: true, email: true, quotaJson: true, lastPingAt: true },
    });

    for (const acc of accountsWithPing) {
      const quota = parseQuotaJson(acc.quotaJson);
      const now = new Date();

      // pingStillValid: last ping happened AND it was within the last 5 hours
      const pingAgeMs = acc.lastPingAt ? now.getTime() - new Date(acc.lastPingAt).getTime() : Infinity;
      const pingStillValid = acc.lastPingAt != null && pingAgeMs < FIVE_HOURS_MS;

      // Gemini: timer active if resetTime future AND (ping still in-window OR consuming)
      const geminiResetFuture = !!(quota?.gemini.resetTime5h && new Date(quota.gemini.resetTime5h) > now);
      const geminiConsumed = quota?.gemini.remaining5h != null && quota.gemini.remaining5h < 0.9999;
      const geminiTimerActive = geminiResetFuture && (pingStillValid || geminiConsumed);
      const geminiExhausted = quota?.gemini.weeklyStatus === 'exhausted';
      const geminiNeedsPing = !!(quota && !geminiTimerActive && !geminiExhausted);

      // Claude: timer active if resetTime future AND (ping still in-window OR consuming)
      const claudeResetFuture = !!(quota?.anthropic.resetTime5h && new Date(quota.anthropic.resetTime5h) > now);
      const claudeConsumed = quota?.anthropic.remaining5h != null && quota.anthropic.remaining5h < 0.9999;
      const claudeTimerActive = claudeResetFuture && (pingStillValid || claudeConsumed);
      const claudeExhausted = quota?.anthropic.weeklyStatus === 'exhausted';
      const claudeNeedsPing = !!(quota && !claudeTimerActive && !claudeExhausted);

      const pingAgeFmt = isFinite(pingAgeMs)
        ? `${Math.floor(pingAgeMs / 60000)}m ago`
        : 'never';

      if (geminiNeedsPing || claudeNeedsPing) {
        console.log(
          `[scheduler] Auto-pinging ${acc.email} | lastPing=${pingAgeFmt} pingStillValid=${pingStillValid}` +
          ` | Gemini=${geminiNeedsPing} [future=${geminiResetFuture},consumed=${geminiConsumed}]` +
          ` | Claude=${claudeNeedsPing} [future=${claudeResetFuture},consumed=${claudeConsumed}]`
        );
        pingAccount(acc.id, { pingGemini: geminiNeedsPing, pingClaude: claudeNeedsPing }).catch((err: unknown) =>
          console.error(`[scheduler] Ping failed for ${acc.email}:`, err)
        );
      } else {
        console.log(
          `[scheduler] Skipping ${acc.email} | lastPing=${pingAgeFmt} pingStillValid=${pingStillValid}` +
          ` | Gemini: active=${geminiTimerActive} exhausted=${geminiExhausted}` +
          ` | Claude: active=${claudeTimerActive} exhausted=${claudeExhausted}`
        );
      }
    }
    // ── Token pre-warming: refresh tokens expiring within 5 min ───────────────
    await preWarmTokenCache().catch((err) =>
      console.error('[scheduler] Token pre-warm failed:', err)
    );
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
 * NOTE: local_ls is not used — no MITM reliance.
 */
export async function refreshNow(accountId: string): Promise<void> {
  await refreshQuotaForAccount(accountId, []);
}
