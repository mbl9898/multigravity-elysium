// src/test/DashboardSorting.test.ts
// Unit tests for the dashboard account sorting utility functions.

import { describe, it, expect } from 'vitest';
import { getResetRemainingMs } from '@/components/Dashboard';
import type { Account, PoolQuota } from '@/types';

// Helper to create mock Account objects
function createMockAccount(id: string, email: string, quota: Account['quota']): Account {
  return {
    id,
    email,
    nickname: null,
    tier: null,
    quota,
    lastChecked: null,
    lastError: null,
    health: 'healthy',
    createdAt: new Date().toISOString(),
    lastPingAt: null,
    lastPingStatus: null,
    lastPingError: null,
    validationRequired: false,
  };
}

describe('Dashboard Sorting Utilities', () => {
  const now = new Date('2026-07-13T12:00:00Z').getTime();

  it('getResetRemainingMs returns Infinity for missing quota or pool info', () => {
    const account1 = createMockAccount('1', 'a@example.com', null);
    expect(getResetRemainingMs(account1, 'gemini', '5h', now)).toBe(Infinity);

    const account2 = createMockAccount('2', 'b@example.com', {
      gemini: null as unknown as PoolQuota,
      anthropic: null as unknown as PoolQuota,
    });
    expect(getResetRemainingMs(account2, 'gemini', '5h', now)).toBe(Infinity);
  });

  it('getResetRemainingMs returns Infinity if exhausted but reset time is null', () => {
    const account = createMockAccount('1', 'a@example.com', {
      gemini: {
        remaining5h: 0,
        resetTime5h: null,
        remaining7d: null,
        resetTime7d: null,
        weeklyStatus: 'unknown',
      },
      anthropic: {
        remaining5h: null,
        resetTime5h: null,
        remaining7d: null,
        resetTime7d: null,
        weeklyStatus: 'exhausted',
      },
    });

    // 5h is exhausted (remaining5h <= 0) and has no resetTime5h -> Infinity
    expect(getResetRemainingMs(account, 'gemini', '5h', now)).toBe(Infinity);
    // Weekly is exhausted and has no resetTime7d -> Infinity
    expect(getResetRemainingMs(account, 'anthropic', '7d', now)).toBe(Infinity);
  });

  it('getResetRemainingMs returns 0 if not exhausted and reset time is null', () => {
    const account = createMockAccount('1', 'a@example.com', {
      gemini: {
        remaining5h: 0.5,
        resetTime5h: null,
        remaining7d: null,
        resetTime7d: null,
        weeklyStatus: 'ok',
      },
      anthropic: {
        remaining5h: null,
        resetTime5h: null,
        remaining7d: null,
        resetTime7d: null,
        weeklyStatus: 'unknown',
      },
    });

    expect(getResetRemainingMs(account, 'gemini', '5h', now)).toBe(0);
    expect(getResetRemainingMs(account, 'anthropic', '7d', now)).toBe(0);
  });

  it('getResetRemainingMs computes correct difference in milliseconds', () => {
    const account = createMockAccount('1', 'a@example.com', {
      gemini: {
        remaining5h: 0,
        resetTime5h: '2026-07-13T12:05:00Z', // 5 mins in future
        remaining7d: 0,
        resetTime7d: '2026-07-13T11:55:00Z', // 5 mins in past
        weeklyStatus: 'exhausted',
      },
      anthropic: {
        remaining5h: null,
        resetTime5h: null,
        remaining7d: null,
        resetTime7d: null,
        weeklyStatus: 'unknown',
      },
    });

    // Future reset time: 5 minutes = 300,000 ms
    expect(getResetRemainingMs(account, 'gemini', '5h', now)).toBe(300000);
    // Past reset time: 0
    expect(getResetRemainingMs(account, 'gemini', '7d', now)).toBe(0);
  });
});
