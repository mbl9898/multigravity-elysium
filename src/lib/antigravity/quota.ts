// src/lib/antigravity/quota.ts
// Fetches quota data for an account from Antigravity's internal API.
// ALL calls are server-side only — the browser never touches these endpoints.
//
// Endpoint isolation: if cloudcode-pa.googleapis.com changes, only this file needs updating.
// Last successful check time is tracked so the UI can show "stale data" warnings.

import type { AccountQuota, PoolQuota } from '@/types';

// Must match the IDE language server's --cloud_code_endpoint.
const CLOUDCODE_BASE = 'https://daily-cloudcode-pa.googleapis.com';

// ─── loadCodeAssist in-memory cache ──────────────────────────────────────────
// Keyed by access token. TTL = 55 minutes (access tokens live 60 min).
// Prevents duplicate API hits within the same daemon refresh cycle.

interface LoadCodeAssistCacheEntry {
  result: { projectId: string; tier: string | null; validationRequired: boolean };
  expiresAt: number;
}

const _loadCodeAssistCache = new Map<string, LoadCodeAssistCacheEntry>();
const LCA_CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes

/** Evict expired entries to avoid unbounded map growth. */
function _pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of _loadCodeAssistCache) {
    if (entry.expiresAt <= now) _loadCodeAssistCache.delete(key);
  }
}

// ─── Retry helper for 429 ─────────────────────────────────────────────────────
/**
 * Calls an async factory with exponential backoff on HTTP 429 responses.
 * On the first attempt it executes immediately; subsequent retries wait
 * `baseDelayMs * 2^attempt` milliseconds before retrying.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const maxRetries = opts.retries ?? 2;
  const baseDelay = opts.baseDelayMs ?? 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry on 429 errors
      if (!msg.includes('429')) throw err;
      console.warn(`[quota] 429 received — retrying (attempt ${attempt + 1}/${maxRetries})…`);
    }
  }
  throw lastErr;
}

// ─── Step 1: loadCodeAssist ──────────────────────────────────────────────────

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  // tier fields may be a string OR an object like { displayName: 'Ultra', tierCode: 'ULTRA' }
  // We normalize to a plain string for storage.
  paidTier?: string | { displayName?: string; tierCode?: string; name?: string } | null;
  currentTier?: string | { displayName?: string; tierCode?: string; name?: string } | null;
  ineligibleTiers?: { reasonCode?: string; reasonMessage?: string }[];
}

/**
 * Calls loadCodeAssist to get the account's projectId and tier.
 * Must be called before fetchAvailableModels.
 */
export async function loadCodeAssist(
  accessToken: string
): Promise<{ projectId: string; tier: string | null; validationRequired: boolean }> {
  // ── Cache check ──────────────────────────────────────────────────────────────
  _pruneCache();
  const cached = _loadCodeAssistCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[loadCodeAssist] Cache hit — skipping API call.');
    return cached.result;
  }

  // ── Fetch with exponential-backoff retry on 429 ───────────────────────────
  const result = await withRetry(async () => {
    const response = await fetch(`${CLOUDCODE_BASE}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'AntigravityQuotaWatcher/1.0',
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    });

    if (!response.ok) {
      throw new Error(`loadCodeAssist failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as LoadCodeAssistResponse;

    let projectId = data.cloudaicompanionProject;
    const rawTier = data.paidTier ?? data.currentTier ?? null;
    const tier = normalizeTier(rawTier);

    // Detect SARP / VALIDATION_REQUIRED — account is blocked in IDE but works in CLI
    const validationRequired = !!(data.ineligibleTiers?.some(t => t.reasonCode === 'VALIDATION_REQUIRED'));

    if (!projectId) {
      if (tier) {
        console.log(`[loadCodeAssist] Missing cloudaicompanionProject for paid tier (${tier}), using fallback.`);
        projectId = 'REDACTED_FALLBACK_PROJECT_ID';
      } else if (validationRequired) {
        // Account needs SARP verification — flag it but use fallback project so quota still works
        console.warn(`[loadCodeAssist] VALIDATION_REQUIRED for account — flagging as validationRequired, using fallback projectId.`);
        projectId = 'REDACTED_FALLBACK_PROJECT_ID';
      } else {
        throw new Error('loadCodeAssist returned no projectId (cloudaicompanionProject missing)');
      }
    }

    return { projectId, tier, validationRequired };
  }, { retries: 2, baseDelayMs: 2000 });

  // ── Populate cache ────────────────────────────────────────────────────────
  _loadCodeAssistCache.set(accessToken, { result, expiresAt: Date.now() + LCA_CACHE_TTL_MS });

  return result;
}

/**
 * Normalizes the tier field from loadCodeAssist.
 * The real API may return a string ("Pro") or an object ({ displayName: "Ultra" }).
 */
function normalizeTier(
  raw: string | { displayName?: string; tierCode?: string; name?: string } | null | undefined
): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  // It's an object — extract the most human-readable field
  return raw.displayName ?? raw.name ?? raw.tierCode ?? JSON.stringify(raw);
}

// ─── Step 2: retrieveUserQuotaSummary ─────────────────────────────────────────

interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction?: number;
}

interface QuotaGroup {
  buckets?: QuotaBucket[];
  displayName?: string;
  description?: string;
}

interface UserQuotaSummaryResponse {
  groups?: QuotaGroup[];
  description?: string;
}

/**
 * Fetches the user quota summary from the Cloud Code API.
 * This is the official endpoint that returns both weekly and 5-hour limits.
 */
async function retrieveUserQuotaSummary(
  accessToken: string,
  projectId: string
): Promise<UserQuotaSummaryResponse> {
  const response = await fetch(`${CLOUDCODE_BASE}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // User-Agent matching the CLI/IDE pattern to bypass Google's gating
      'User-Agent': 'antigravity/1.11.3 windows/amd64',
    },
    body: JSON.stringify({ project: projectId }),
  });

  if (!response.ok) {
    throw new Error(`retrieveUserQuotaSummary failed (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as UserQuotaSummaryResponse;
}

// ─── Main quota fetch ─────────────────────────────────────────────────────────

/**
 * Full quota fetch pipeline for one account.
 * Returns normalized AccountQuota ready to store in the database.
 *
 * @param accessToken - Fresh (in-memory only) Google access token
 * @param projectId   - From loadCodeAssist
 */
export async function fetchAccountQuota(
  accessToken: string,
  projectId: string
): Promise<AccountQuota> {
  const summary = await retrieveUserQuotaSummary(accessToken, projectId);
  const groups = summary.groups ?? [];

  let geminiQuota: PoolQuota = {
    remaining5h: null,
    resetTime5h: null,
    remaining7d: null,
    resetTime7d: null,
    weeklyStatus: 'unknown',
  };

  let anthropicQuota: PoolQuota = {
    remaining5h: null,
    resetTime5h: null,
    remaining7d: null,
    resetTime7d: null,
    weeklyStatus: 'unknown',
  };

  for (const group of groups) {
    const displayName = group.displayName ?? '';
    const description = group.description ?? '';
    const isGemini = /gemini/i.test(displayName) || /gemini/i.test(description);
    const isAnthropic = /claude|3p|anthropic|gpt/i.test(displayName) || /claude|3p|anthropic|gpt/i.test(description);

    const quota: PoolQuota = {
      remaining5h: null,
      resetTime5h: null,
      remaining7d: null,
      resetTime7d: null,
      weeklyStatus: 'unknown',
    };

    const buckets = group.buckets ?? [];
    for (const bucket of buckets) {
      const bId = bucket.bucketId ?? '';
      const bName = bucket.displayName ?? '';
      const bWindow = bucket.window ?? '';
      
      const isWeekly = bWindow === 'weekly' || /weekly/i.test(bName) || /weekly/i.test(bId);
      const is5h = bWindow === '5h' || /5h|5.?hour/i.test(bName) || /5h|5.?hour/i.test(bId);

      const fraction = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : null;

      if (isWeekly) {
        quota.remaining7d = fraction;
        quota.resetTime7d = bucket.resetTime ?? null;
        quota.weeklyStatus = fraction === 0 ? 'exhausted' : (fraction !== null ? 'ok' : 'unknown');
      } else if (is5h) {
        quota.remaining5h = fraction;
        quota.resetTime5h = bucket.resetTime ?? null;
      }
    }

    if (isGemini) {
      geminiQuota = quota;
    } else if (isAnthropic) {
      anthropicQuota = quota;
    }
  }

  return { gemini: geminiQuota, anthropic: anthropicQuota };
}
