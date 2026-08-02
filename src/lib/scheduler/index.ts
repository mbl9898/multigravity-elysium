// src/lib/scheduler/index.ts
// Background quota refresh scheduler.
// Runs as an in-process singleton in the Next.js server (not in the browser).
//
// Refresh cadence (tiered):
//   Active account  — every  30 seconds  (ACTIVE_POLL_INTERVAL_MS)
//   All other accounts — every 5 minutes  (IDLE_POLL_INTERVAL_MS)
//
// "Active account" = the account most recently used by the API gateway router.
// This is tracked in-memory by accountRouter.getLastUsedAccountId().
//
// Requests are staggered by STAGGER_DELAY_MS between accounts to avoid burst
// traffic to cloudcode-pa.googleapis.com and prevent 429 RESOURCE_EXHAUSTED.
//
// In development: starts automatically when Next.js dev server starts.
// In production: PM2 keeps the process alive, so the scheduler keeps running.
//
// NOTE: local_ls (MITM-dependent) is intentionally NOT used here.
// All quota data comes from the remote Google API directly via ping.ts DNS bypass.

import { execSync } from 'child_process';
import { prisma } from '@/lib/database/client';
import { refreshQuotaForAccount, parseQuotaJson } from '@/lib/database/accounts';
import { pingAccount } from '@/lib/antigravity/ping';
import { getV2ActiveEmail, setV2ActiveEmail } from '@/app/api/v2/switch-account/route';

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

/** In-memory cache: email → DB account ID so we don't query on every 15 s tick. */
const globalV2Cache = globalThis as typeof globalThis & {
  __v2ActiveDbId__?: string | null;
  __v2ActiveDbEmail__?: string | null; // email that was resolved to the ID
};

/**
 * Resolve the V2 active email to a DB account ID.
 * Caches the result in globalThis so it survives HMR without repeated DB queries.
 * Invalidates automatically when the email changes.
 */
async function getV2ActiveId(): Promise<string | null> {
  const email = getV2ActiveEmail();
  if (!email) {
    globalV2Cache.__v2ActiveDbId__ = null;
    globalV2Cache.__v2ActiveDbEmail__ = null;
    return null;
  }
  // Reuse cache if the email hasn't changed
  if (email === globalV2Cache.__v2ActiveDbEmail__) {
    return globalV2Cache.__v2ActiveDbId__ ?? null;
  }
  // Email changed (or first call) — look up the DB ID
  const rows = await prisma.account.findMany({ select: { id: true, email: true } }).catch(() => [] as { id: string; email: string }[]);
  const match = rows.find((r) => r.email.toLowerCase().trim() === email);
  globalV2Cache.__v2ActiveDbId__ = match?.id ?? null;
  globalV2Cache.__v2ActiveDbEmail__ = email;
  return globalV2Cache.__v2ActiveDbId__ ?? null;
}

/**
 * Determine the active account ID for tiered scheduling.
 * Priority:
 *   1. Router's live last-used account (set when API traffic flows through)
 *   2. V2 active account from the in-process global (set when GET /api/v2/switch-account is called)
 *   3. null → all accounts treated as idle
 */
async function getActiveAccountId(): Promise<string | null> {
  // 1. Router in-memory (most authoritative when traffic exists)
  try {
    const routerPath = '@/lib/router/accountRouter';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ routerPath).catch(() => null);
    if (typeof mod?.getLastUsedAccountId === 'function') {
      const routerId = mod.getLastUsedAccountId() as string | null;
      if (routerId) return routerId;
    }
  } catch {
    // ignore
  }
  // 2. V2 active account (populated whenever the dashboard polls GET /api/v2/switch-account)
  return getV2ActiveId();
}

// ─── Scheduler state ──────────────────────────────────────────────────────────

// Prevent duplicate interval handles under Next.js Hot Module Replacement (HMR)
const globalScheduler = globalThis as typeof globalThis & {
  __schedulerHandle__?: NodeJS.Timeout | null;
  __schedulerRunning__?: boolean;
  /** Tracks when each account was last refreshed (epoch ms). */
  __lastRefreshed__?: Map<string, number>;
};

const ACTIVE_POLL_INTERVAL_MS =  30 * 1000;       //  30 seconds — active account
const IDLE_POLL_INTERVAL_MS   =  5 * 60 * 1000;  //   5 minutes — all other accounts
const TICK_INTERVAL_MS        =  15 * 1000;       //  15 seconds — how often the scheduler wakes up to check
const STAGGER_DELAY_MS        =  300;             //  ms between sequential account refreshes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLastRefreshed(): Map<string, number> {
  if (!globalScheduler.__lastRefreshed__) {
    globalScheduler.__lastRefreshed__ = new Map();
  }
  return globalScheduler.__lastRefreshed__;
}

/** Returns true if the account is due for a refresh given its cadence. */
function isDue(accountId: string, isActive: boolean): boolean {
  const lastRefreshed = getLastRefreshed();
  const last = lastRefreshed.get(accountId) ?? 0;
  const interval = isActive ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
  return Date.now() - last >= interval;
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Core refresh cycle ───────────────────────────────────────────────────────

/**
 * One scheduler tick: determine which accounts are due for a refresh,
 * then process them sequentially with a stagger delay to avoid burst traffic.
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

    const activeId = await getActiveAccountId();
    const lastRefreshed = getLastRefreshed();

    // Separate accounts into active vs idle, filter to only those due for refresh
    const activeAccounts = accounts.filter((a) => a.id === activeId && isDue(a.id, true));
    const idleAccounts  = accounts.filter((a) => a.id !== activeId && isDue(a.id, false));

    const due = [...activeAccounts, ...idleAccounts];

    if (due.length > 0) {
      console.log(
        `[scheduler] Refreshing ${due.length}/${accounts.length} account(s) ` +
        `(active=${activeAccounts.length}, idle=${idleAccounts.length}, stagger=${STAGGER_DELAY_MS}ms)`
      );

      // NOTE: local_ls is NOT used — it relies on MITM proxy data.
      // All quota data comes directly from the remote Google API.
      for (const acc of due) {
        await refreshQuotaForAccount(acc.id, []);
        lastRefreshed.set(acc.id, Date.now());
        if (due.indexOf(acc) < due.length - 1) {
          // Stagger: wait between accounts to avoid a burst of simultaneous requests
          await sleep(STAGGER_DELAY_MS);
        }
      }
    }

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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the background scheduler.
 * Safe to call multiple times — only starts once (idempotent).
 *
 * The scheduler wakes up every TICK_INTERVAL_MS (15s) and decides which
 * accounts are due for refresh based on their individual cadence:
 *   - Active account: due every ACTIVE_POLL_INTERVAL_MS (30s)
 *   - Idle accounts:  due every IDLE_POLL_INTERVAL_MS   (5 min)
 */
export function startScheduler(): void {
  if (globalScheduler.__schedulerHandle__) return;

  console.log(
    `[scheduler] Starting quota refresh ` +
    `(active cadence: ${ACTIVE_POLL_INTERVAL_MS / 1000}s, ` +
    `idle cadence: ${IDLE_POLL_INTERVAL_MS / 1000}s, ` +
    `tick: ${TICK_INTERVAL_MS / 1000}s, ` +
    `stagger: ${STAGGER_DELAY_MS}ms)`
  );

  // Seed the V2 active email immediately at startup (before first tick)
  // so the active account gets the fast cadence from the very first cycle.
  void (async () => {
    try {
      const raw = execSync(
        'security find-generic-password -s "gemini" -a "antigravity" -w',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }
      ).trim();
      const PREFIX = 'go-keyring-base64:';
      if (raw.startsWith(PREFIX)) {
        const decoded = JSON.parse(
          Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8')
        ) as { token?: { access_token?: string } };
        const at = decoded?.token?.access_token;
        if (at) {
          const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${at}` },
          });
          if (infoRes.ok) {
            const info = await infoRes.json() as { email?: string };
            if (info.email) {
              setV2ActiveEmail(info.email);
              console.log(`[scheduler] Seeded V2 active email: ${info.email}`);
            }
          }
        }
      }
    } catch {
      // Keychain not available or network error — dashboard's 30 s poll will seed it soon
    }
  })();

  // Run immediately on start, then on interval
  void runRefreshCycle();
  globalScheduler.__schedulerHandle__ = setInterval(() => {
    void runRefreshCycle();
  }, TICK_INTERVAL_MS);
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
  // Also mark it as freshly refreshed so the cadence clock resets
  getLastRefreshed().set(accountId, Date.now());
}
