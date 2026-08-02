// src/lib/sorting.ts
// Shared account sorting utilities for Dashboard and Chat views.

import type { Account } from '@/types';

export type SortMode =
  | 'email'
  | 'gemini-weekly-reset'
  | 'anthropic-weekly-reset'
  | 'gemini-5h-reset'
  | 'anthropic-5h-reset';

export const SORT_STORAGE_KEY = 'dashboard-sort-mode';

export function getResetRemainingMs(
  account: Account,
  pool: 'gemini' | 'anthropic',
  type: '5h' | '7d',
  now: number
): number {
  const quota = account.quota;
  if (!quota) return Infinity;
  const p = quota[pool];
  if (!p) return Infinity;

  const resetTimeStr = type === '5h' ? p.resetTime5h : p.resetTime7d;
  if (!resetTimeStr) {
    const isExhausted =
      type === '5h'
        ? p.remaining5h !== null && p.remaining5h <= 0
        : p.weeklyStatus === 'exhausted';
    return isExhausted ? Infinity : 0;
  }

  const target = new Date(resetTimeStr).getTime();
  const diffMs = target - now;
  return diffMs <= 0 ? 0 : diffMs;
}

export function isPoolExhausted(
  account: Account,
  pool: 'gemini' | 'anthropic'
): boolean {
  const quota = account.quota;
  if (!quota) return false;
  const p = quota[pool];
  if (!p) return false;

  return (
    p.weeklyStatus === 'exhausted' ||
    (p.remaining5h !== null && p.remaining5h <= 0)
  );
}

export function getPoolRecoveryTimeMs(
  account: Account,
  pool: 'gemini' | 'anthropic',
  now: number
): number {
  const quota = account.quota;
  if (!quota) return Infinity;
  const p = quota[pool];
  if (!p) return Infinity;

  const is5hExhausted = p.remaining5h !== null && p.remaining5h <= 0;
  const isWeeklyExhausted = p.weeklyStatus === 'exhausted';

  if (!is5hExhausted && !isWeeklyExhausted) return 0;

  const reset5h = getResetRemainingMs(account, pool, '5h', now);
  const reset7d = getResetRemainingMs(account, pool, '7d', now);

  const time5h = is5hExhausted ? reset5h : 0;
  const time7d = isWeeklyExhausted ? reset7d : 0;

  return Math.max(time5h, time7d);
}

export function sortAccounts(
  accounts: Account[],
  sortMode: SortMode,
  now: number = Date.now()
): Account[] {
  return [...accounts].sort((a, b) => {
    if (sortMode === 'email') {
      return a.email.localeCompare(b.email);
    }

    let pool: 'gemini' | 'anthropic' = 'gemini';
    if (sortMode.startsWith('anthropic')) {
      pool = 'anthropic';
    }

    const isAExhausted = isPoolExhausted(a, pool);
    const isBExhausted = isPoolExhausted(b, pool);

    if (isAExhausted && !isBExhausted) return 1;
    if (!isAExhausted && isBExhausted) return -1;

    let valA = 0;
    let valB = 0;

    if (isAExhausted && isBExhausted) {
      valA = getPoolRecoveryTimeMs(a, pool, now);
      valB = getPoolRecoveryTimeMs(b, pool, now);
    } else {
      if (sortMode === 'gemini-weekly-reset') {
        valA = getResetRemainingMs(a, 'gemini', '7d', now);
        valB = getResetRemainingMs(b, 'gemini', '7d', now);
      } else if (sortMode === 'anthropic-weekly-reset') {
        valA = getResetRemainingMs(a, 'anthropic', '7d', now);
        valB = getResetRemainingMs(b, 'anthropic', '7d', now);
      } else if (sortMode === 'gemini-5h-reset') {
        valA = getResetRemainingMs(a, 'gemini', '5h', now);
        valB = getResetRemainingMs(b, 'gemini', '5h', now);
      } else if (sortMode === 'anthropic-5h-reset') {
        valA = getResetRemainingMs(a, 'anthropic', '5h', now);
        valB = getResetRemainingMs(b, 'anthropic', '5h', now);
      }
    }

    if (valA === valB) {
      return a.email.localeCompare(b.email);
    }

    return valA - valB;
  });
}
