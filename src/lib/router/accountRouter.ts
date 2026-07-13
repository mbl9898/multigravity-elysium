// src/lib/router/accountRouter.ts
// Quota-aware per-message account selector for the Elysium API gateway.
//
// Supports four routing modes configured via the Settings table:
//   smart        — two-tier "use-it-before-you-lose-it" + round-robin within tiers
//   round-robin  — equal rotation across all healthy accounts
//   locked       — always use a single pinned account
//   custom       — user-defined subset, round-robin within it
//
// In-flight locking (inFlight Set) is the back-pressure mechanism.
// No ConcurrencyQueue is used — HTTP to localhost is cheap and the inFlight
// lock already prevents the same account from being double-booked.

import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';
import type { AccountQuota, PoolQuota } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoutingMode = 'smart' | 'round-robin' | 'locked' | 'custom';

export interface RoutingSettings {
  mode: RoutingMode;
  lockedAccountId: string | null;
  customAccountIds: string[];
}

interface AccountRow {
  id: string;
  email: string;
  encryptedRefreshToken: string;
  isHealthy: boolean;
  quotaJson: string | null;
}

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Lazy access-token cache. Survives across requests within one server lifetime. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Accounts actively serving a live request. Prevents double-booking. */
const inFlight = new Set<string>();

/**
 * Per-pool round-robin index. Incremented after each selection so the next
 * request goes to the next account in the sorted candidate list.
 */
const rrIndex: Record<'gemini' | 'anthropic', number> = { gemini: 0, anthropic: 0 };

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AccountPoolExhaustedError extends Error {
  constructor(public readonly pool: string, public readonly mode: string) {
    super(`All accounts exhausted for pool: ${pool} (mode: ${mode})`);
    this.name = 'AccountPoolExhaustedError';
  }
}

export class LockedAccountUnavailableError extends Error {
  constructor(public readonly accountId: string) {
    super(`Locked account ${accountId} is unavailable (exhausted or unhealthy)`);
    this.name = 'LockedAccountUnavailableError';
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** Read the routing strategy from the DB. Falls back to smart mode if missing. */
async function getRoutingSettings(): Promise<RoutingSettings> {
  const row = await prisma.settings.findUnique({ where: { id: 'global' } }).catch(() => null);
  if (!row) {
    return { mode: 'smart', lockedAccountId: null, customAccountIds: [] };
  }
  let customAccountIds: string[] = [];
  if (row.customAccountIds) {
    try { customAccountIds = JSON.parse(row.customAccountIds) as string[]; } catch { /* ignore */ }
  }
  return {
    mode: row.routingMode as RoutingMode,
    lockedAccountId: row.lockedAccountId ?? null,
    customAccountIds,
  };
}

// ─── Quota helpers ────────────────────────────────────────────────────────────

function parseQuota(quotaJson: string | null): AccountQuota | null {
  if (!quotaJson) return null;
  try { return JSON.parse(quotaJson) as AccountQuota; } catch { return null; }
}

function getPoolQuota(quota: AccountQuota | null, pool: 'gemini' | 'anthropic'): PoolQuota | null {
  return quota?.[pool] ?? null;
}

/** Days until the weekly quota resets. Returns Infinity if unknown. */
function daysUntilWeeklyReset(pq: PoolQuota | null): number {
  if (!pq?.resetTime7d) return Infinity;
  const ms = new Date(pq.resetTime7d).getTime() - Date.now();
  return ms / 86_400_000;
}

/** True when the account's pool quota allows new requests. */
function isPoolAvailable(quota: AccountQuota | null, pool: 'gemini' | 'anthropic'): boolean {
  const pq = getPoolQuota(quota, pool);
  if (!pq) return true; // quota unknown → optimistically allow
  if (pq.weeklyStatus === 'exhausted') return false;
  if (pq.remaining5h !== null && pq.remaining5h <= 0) return false;
  return true;
}

// ─── Candidate filtering ──────────────────────────────────────────────────────

/**
 * Load all accounts from DB, apply mode-specific allowlist, then filter to
 * those that are healthy, not in-flight, and have available quota for the pool.
 */
async function getCandidates(
  pool: 'gemini' | 'anthropic',
  settings: RoutingSettings,
): Promise<Array<AccountRow & { quota: AccountQuota | null }>> {
  const rows = await prisma.account.findMany({
    select: {
      id: true,
      email: true,
      encryptedRefreshToken: true,
      isHealthy: true,
      quotaJson: true,
    },
  });

  // Apply mode-specific account allowlist
  let allowed = rows;
  if (settings.mode === 'locked' && settings.lockedAccountId) {
    allowed = rows.filter((r) => r.id === settings.lockedAccountId);
  } else if (settings.mode === 'custom' && settings.customAccountIds.length > 0) {
    const allowed_set = new Set(settings.customAccountIds);
    allowed = rows.filter((r) => allowed_set.has(r.id));
  }

  return allowed
    .map((r) => ({ ...r, quota: parseQuota(r.quotaJson) }))
    .filter(
      (r) =>
        r.isHealthy &&
        !inFlight.has(r.id) &&
        isPoolAvailable(r.quota, pool),
    );
}

// ─── Selection algorithms ─────────────────────────────────────────────────────

/**
 * Smart mode — two-tier "use-it-before-you-lose-it" strategy.
 *
 * Tier 1 (urgent):  resetTime7d ≤ 2 days away AND remaining7d > 0
 *                   → perishable quota, must use before it resets
 * Tier 2 (normal):  everything else
 *
 * Round-robin within each tier. Tier 1 is always exhausted first.
 *
 * IMPORTANT: Both tiers are sorted by account ID before applying the
 * round-robin index. This ensures the order is stable across DB queries
 * (which return rows in arbitrary/insertion order) and across daemon
 * restarts (rrIndex always restarts at 0, so deterministic sort = same
 * starting account each boot, then advances correctly).
 */
function selectSmart(
  candidates: Array<AccountRow & { quota: AccountQuota | null }>,
  pool: 'gemini' | 'anthropic',
): AccountRow & { quota: AccountQuota | null } {
  const tier1 = candidates.filter((c) => {
    const pq = getPoolQuota(c.quota, pool);
    const days = daysUntilWeeklyReset(pq);
    const hasWeeklyLeft = pq?.remaining7d === null || (pq?.remaining7d ?? 0) > 0;
    return days <= 2 && hasWeeklyLeft;
  });

  // Sort both tiers by ID so ordering is stable regardless of DB row order
  const sorted_tier1 = [...tier1].sort((a, b) => a.id.localeCompare(b.id));
  const sorted_all = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const pool_arr = sorted_tier1.length > 0 ? sorted_tier1 : sorted_all;

  const idx = rrIndex[pool] % pool_arr.length;
  rrIndex[pool] = idx + 1; // advance for next call (monotonically increasing)
  return pool_arr[idx]!;
}

/** Round-robin across all candidates, stable order by email. */
function selectRoundRobin(
  candidates: Array<AccountRow & { quota: AccountQuota | null }>,
  pool: 'gemini' | 'anthropic',
): AccountRow & { quota: AccountQuota | null } {
  const sorted = [...candidates].sort((a, b) => a.email.localeCompare(b.email));
  const idx = rrIndex[pool] % sorted.length;
  rrIndex[pool] = idx + 1;
  return sorted[idx]!;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Select the best available account for the given pool, lock it for the
 * duration of the request, and return a fresh access token.
 *
 * The caller MUST call releaseAccount(accountId) when the request finishes
 * (success, error, or stream close).
 *
 * @throws AccountPoolExhaustedError   when no healthy account with quota remains
 * @throws LockedAccountUnavailableError  when locked mode but the account is down
 */
export async function selectAndLockAccount(
  pool: 'gemini' | 'anthropic',
): Promise<{ accountId: string; email: string; accessToken: string }> {
  const settings = await getRoutingSettings();
  const candidates = await getCandidates(pool, settings);

  if (candidates.length === 0) {
    if (settings.mode === 'locked' && settings.lockedAccountId) {
      throw new LockedAccountUnavailableError(settings.lockedAccountId);
    }
    throw new AccountPoolExhaustedError(pool, settings.mode);
  }

  let selected: AccountRow & { quota: AccountQuota | null };

  switch (settings.mode) {
    case 'smart':
      selected = selectSmart(candidates, pool);
      break;
    case 'round-robin':
    case 'custom':
      selected = selectRoundRobin(candidates, pool);
      break;
    case 'locked':
      // Only one candidate possible after allowlist filter — just take it
      selected = candidates[0]!;
      break;
    default:
      selected = selectSmart(candidates, pool);
  }

  inFlight.add(selected.id);
  const accessToken = await getAccessToken(selected.id, selected.encryptedRefreshToken);
  return { accountId: selected.id, email: selected.email, accessToken };
}

/** Release an account's in-flight lock. Call in success, error, and stream-close paths. */
export function releaseAccount(accountId: string): void {
  inFlight.delete(accountId);
}

/**
 * Mark a pool as exhausted for a specific account.
 * Called when Google returns HTTP 429 / 403 at connection time.
 * Only the relevant pool's weeklyStatus is updated; the other pool is untouched.
 */
export async function markExhausted(
  accountId: string,
  pool: 'gemini' | 'anthropic',
): Promise<void> {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: { quotaJson: true },
  });
  if (!row) return;

  const quota = parseQuota(row.quotaJson) ?? {
    gemini: { remaining5h: null, resetTime5h: null, remaining7d: null, resetTime7d: null, weeklyStatus: 'unknown' as const },
    anthropic: { remaining5h: null, resetTime5h: null, remaining7d: null, resetTime7d: null, weeklyStatus: 'unknown' as const },
  };

  quota[pool] = { ...quota[pool], weeklyStatus: 'exhausted', remaining5h: 0 };

  await prisma.account.update({
    where: { id: accountId },
    data: { quotaJson: JSON.stringify(quota) },
  });
}

// ─── Token cache ──────────────────────────────────────────────────────────────

/**
 * Get a valid access token for the account. Refreshes only when the cached
 * token expires within 2 minutes (avoids hot-path round-trips to Google OAuth).
 */
async function getAccessToken(accountId: string, encryptedRefreshToken: string): Promise<string> {
  const cached = tokenCache.get(accountId);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 120_000) {
    return cached.token;
  }
  const refreshToken = decrypt(encryptedRefreshToken);
  const result = await refreshAccessToken(refreshToken);
  // refreshAccessToken returns the access token string directly
  // Store with a 55-min expiry (Google access tokens last 60 min)
  tokenCache.set(accountId, {
    token: typeof result === 'string' ? result : (result as { access_token: string }).access_token,
    expiresAt: now + 55 * 60 * 1000,
  });
  return typeof result === 'string' ? result : (result as { access_token: string }).access_token;
}

/**
 * Pre-warm the token cache for all healthy accounts.
 * Called by the background scheduler every 60 seconds.
 * Refreshes tokens expiring within 5 minutes so the hot path never waits.
 */
export async function preWarmTokenCache(): Promise<void> {
  const accounts = await prisma.account
    .findMany({
      where: { isHealthy: true },
      select: { id: true, encryptedRefreshToken: true },
    })
    .catch(() => []);

  const now = Date.now();
  await Promise.allSettled(
    accounts.map(async (acc) => {
      const cached = tokenCache.get(acc.id);
      // Refresh if not cached or expiring within 5 minutes
      if (!cached || cached.expiresAt < now + 5 * 60 * 1000) {
        await getAccessToken(acc.id, acc.encryptedRefreshToken);
      }
    }),
  );
}

// ─── Settings CRUD (used by /api/settings) ────────────────────────────────────

/** Read the current routing settings (public, for the API route). */
export async function readRoutingSettings(): Promise<RoutingSettings> {
  return getRoutingSettings();
}

/** Persist updated routing settings. */
export async function writeRoutingSettings(settings: RoutingSettings): Promise<void> {
  await prisma.settings.upsert({
    where: { id: 'global' },
    update: {
      routingMode: settings.mode,
      lockedAccountId: settings.lockedAccountId ?? null,
      customAccountIds: settings.customAccountIds.length > 0
        ? JSON.stringify(settings.customAccountIds)
        : null,
    },
    create: {
      id: 'global',
      routingMode: settings.mode,
      lockedAccountId: settings.lockedAccountId ?? null,
      customAccountIds: settings.customAccountIds.length > 0
        ? JSON.stringify(settings.customAccountIds)
        : null,
    },
  });
}
