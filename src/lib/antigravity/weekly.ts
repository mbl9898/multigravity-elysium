// src/lib/antigravity/weekly.ts
// Weekly quota probe — sends a tiny real request to detect whether weekly quota is exhausted.
// Called automatically by the background scheduler when weekly status is unknown or stale.
// Also callable manually via the API route for on-demand checks.

import { getRepresentativeModel } from './classifier';
import type { PoolQuota, QuotaPool } from '@/types';

const WEEKLY_ENDPOINT =
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse';

// ─── Go duration parser ───────────────────────────────────────────────────────

/**
 * Parse a Go-style duration string (e.g. "168h0m0s") into total hours.
 * Used to determine if a 429 is a weekly or 5h window exhaustion.
 */
function parseGoDurationToHours(s: string): number {
  const match = s.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const seconds = parseInt(match[3] ?? '0', 10);
  return hours + minutes / 60 + seconds / 3600;
}

// ─── 429 error detail parsing ─────────────────────────────────────────────────

interface ErrorDetail {
  '@type'?: string;
  metadata?: Record<string, string>;
  reason?: string;
}

interface ErrorBody {
  error?: {
    code?: number;
    details?: ErrorDetail[];
  };
}

function extractQuotaInfo(body: ErrorBody): {
  reason: string | null;
  resetDelayHours: number | null;
} {
  const details = body.error?.details ?? [];

  for (const detail of details) {
    const reason = detail.reason ?? detail.metadata?.['reason'] ?? null;
    const resetDelay =
      detail.metadata?.['quotaResetDelay'] ??
      detail.metadata?.['quota_reset_delay'] ??
      null;

    if (reason || resetDelay) {
      return {
        reason,
        resetDelayHours: resetDelay ? parseGoDurationToHours(resetDelay) : null,
      };
    }
  }

  return { reason: null, resetDelayHours: null };
}

// ─── Weekly probe ─────────────────────────────────────────────────────────────

export type WeeklyCheckResult =
  | { type: 'ok' }
  | { type: 'weekly_exhausted'; resetTime: string; resetDelayHours: number }
  | { type: 'fivehour_hit' }   // The 5h window, not weekly — don't conflate
  | { type: 'transient' }      // Rate limit / capacity — ignore
  | { type: 'error'; message: string };

/**
 * Probe the weekly quota limit for a given display pool.
 *
 * Sends a minimal request ("hi", maxOutputTokens: 10) and interprets the response:
 *   200           → pool has weekly quota remaining → 'ok'
 *   429 + hours > 5  → weekly limit hit → 'weekly_exhausted'
 *   429 + hours ≤ 5  → 5h window only → 'fivehour_hit'
 *   429 + transient reason → 'transient'
 *   other error   → 'error'
 *
 * @param accessToken - Fresh in-memory access token
 * @param displayPool - 'gemini' or 'anthropic'
 * @param requestId   - UUID for this request (caller provides)
 */
export async function checkWeeklyQuota(
  accessToken: string,
  displayPool: QuotaPool,
  projectId: string,
  requestId: string
): Promise<WeeklyCheckResult> {
  const model = getRepresentativeModel(displayPool);

  const response = await fetch(
    WEEKLY_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.11.3 windows/amd64',
        'requestId': requestId,
        'requestType': 'agent',
      },
      body: JSON.stringify({
        model: model,
        project: projectId,
        request: {
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 10, temperature: 0.1 },
        },
      }),
    }
  );

  if (response.ok) {
    return { type: 'ok' };
  }

  if (response.status === 429) {
    let body: ErrorBody = {};
    try {
      // SSE endpoint may return newline-delimited JSON — try to parse first line
      const text = await response.text();
      const firstLine = text.split('\n').find((l) => l.startsWith('data:'));
      const jsonStr = firstLine ? firstLine.replace(/^data:\s*/, '') : text;
      body = JSON.parse(jsonStr) as ErrorBody;
    } catch {
      // Parsing failed — treat as transient
      return { type: 'transient' };
    }

    const { reason, resetDelayHours } = extractQuotaInfo(body);

    // Transient errors — not a real quota signal
    if (reason === 'RATE_LIMIT_EXCEEDED' || reason === 'MODEL_CAPACITY_EXHAUSTED') {
      return { type: 'transient' };
    }

    // Real quota exhaustion
    if (reason === 'QUOTA_EXHAUSTED' && resetDelayHours !== null) {
      if (resetDelayHours > 5) {
        // This is the weekly window
        const resetTime = new Date(Date.now() + resetDelayHours * 3600 * 1000).toISOString();
        return { type: 'weekly_exhausted', resetTime, resetDelayHours };
      } else {
        // Just the 5-hour window — don't report as weekly
        return { type: 'fivehour_hit' };
      }
    }

    return { type: 'transient' };
  }

  return {
    type: 'error',
    message: `Unexpected status ${response.status}`,
  };
}

/**
 * Merge a WeeklyCheckResult into an existing PoolQuota object.
 * Only updates weekly fields — preserves existing 5h data.
 *
 * 'ok' → weekly quota is present; keep existing remaining7d if available (quota API may have set it),
 *         otherwise mark remaining7d as 1.0 (unknown but not exhausted).
 * 'weekly_exhausted' → set remaining7d to 0 and store the resetTime.
 * Other results → no weekly state change.
 */
export function applyWeeklyResult(
  existing: PoolQuota,
  result: WeeklyCheckResult
): PoolQuota {
  if (result.type === 'ok') {
    // Keep the existing remaining7d from the quota API if known; otherwise leave null.
    // We confirmed weekly quota exists, but we don't know the exact fraction from the probe alone.
    // The UI will show '✓ Weekly OK' with a '—' bar when remaining7d is null.
    return {
      ...existing,
      weeklyStatus: 'ok',
      remaining7d: existing.remaining7d,  // preserve API-sourced value if any
      resetTime7d: existing.resetTime7d,
    };
  }
  if (result.type === 'weekly_exhausted') {
    return {
      ...existing,
      weeklyStatus: 'exhausted',
      remaining7d: 0,
      resetTime7d: result.resetTime,
    };
  }
  // For transient / fivehour_hit / error — don't change weekly state
  return existing;
}
