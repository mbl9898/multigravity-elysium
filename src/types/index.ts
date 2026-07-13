// src/types/index.ts
// Shared TypeScript types used across the entire application.

export type QuotaPool = 'gemini' | 'anthropic';

export type PoolStatus = 'unknown' | 'ok' | 'exhausted';

export interface PoolQuota {
  /** Fraction remaining, 0.0 (empty) to 1.0 (full). null = not yet fetched. */
  remaining5h: number | null;
  /** ISO 8601 timestamp — when the 5-hour window resets. */
  resetTime5h: string | null;
  /** Fraction remaining for weekly window. null = weekly check never run. */
  remaining7d: number | null;
  /** ISO 8601 timestamp — when the weekly window resets. */
  resetTime7d: string | null;
  /** Weekly status: 'unknown' until the manual check is run. */
  weeklyStatus: PoolStatus;
  /** Optional ISO 8601 timestamp of last weekly probe. */
  lastWeeklyChecked?: string | null;
}

export interface AccountQuota {
  gemini: PoolQuota;
  anthropic: PoolQuota;
}

export type AccountHealth = 'healthy' | 'degraded' | 'error' | 'unauthenticated';

export interface Account {
  id: string;
  email: string;
  nickname: string | null;
  tier: string | null;
  quota: AccountQuota | null;
  lastChecked: string | null; // ISO 8601
  lastError: string | null;
  health: AccountHealth;
  createdAt: string;
  /** ISO 8601 — last time a ping was sent to trigger the 5h countdown */
  lastPingAt: string | null;
  /** 'success' | 'partial' | 'error' | null */
  lastPingStatus: string | null;
  lastPingError: string | null;
  /**
   * True when Google's SARP flow (VALIDATION_REQUIRED) blocks this account
   * from working in Antigravity IDE / V2. The account still works in CLI.
   * Auto-detected on first loadCodeAssist call; can also be set manually.
   */
  validationRequired: boolean;
}

/** What the API returns for the account list (tokens stripped). */
export type AccountSummary = Omit<Account, 'quota'> & {
  quota: AccountQuota | null;
};

/** Internal pool classification from the Antigravity API. */
export type InternalPool = 'gemini3' | 'gemini2.5' | 'claude_gpt' | 'unknown';

export interface ModelQuotaInfo {
  /** 0.0–1.0. NOTE: omitted when 100% full — default to 1.0 when missing. */
  remainingFraction?: number;
  /** ISO 8601 reset timestamp. */
  resetTime?: string;
}

export interface RawModelEntry {
  name: string;
  quotaInfo?: ModelQuotaInfo;
}
