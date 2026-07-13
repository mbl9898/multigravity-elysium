// src/test/accountRouter.test.ts
// Unit tests for Gateway routing logic.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB client
const mockAccounts = [
  {
    id: 'acc1',
    email: 'acc1@gmail.com',
    encryptedRefreshToken: 'enc_acc1_refresh',
    isHealthy: true,
    quotaJson: JSON.stringify({
      gemini: {
        remaining5h: 5,
        resetTime5h: '2026-07-12T20:00:00.000Z',
        remaining7d: 10,
        resetTime7d: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), // resets in 1 day (Urgent / Tier 1)
        weeklyStatus: 'healthy',
      },
      anthropic: {
        remaining5h: 3,
        resetTime5h: '2026-07-12T20:00:00.000Z',
        remaining7d: 5,
        resetTime7d: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(), // resets in 5 days (Normal / Tier 2)
        weeklyStatus: 'healthy',
      },
    }),
  },
  {
    id: 'acc2',
    email: 'acc2@gmail.com',
    encryptedRefreshToken: 'enc_acc2_refresh',
    isHealthy: true,
    quotaJson: JSON.stringify({
      gemini: {
        remaining5h: 5,
        resetTime5h: '2026-07-12T20:00:00.000Z',
        remaining7d: 10,
        resetTime7d: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(), // resets in 5 days (Normal / Tier 2)
        weeklyStatus: 'healthy',
      },
      anthropic: {
        remaining5h: 3,
        resetTime5h: '2026-07-12T20:00:00.000Z',
        remaining7d: 5,
        resetTime7d: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(), // resets in 5 days (Normal / Tier 2)
        weeklyStatus: 'healthy',
      },
    }),
  },
];

let mockSettings = {
  id: 'global',
  routingMode: 'smart',
  lockedAccountId: null as string | null,
  customAccountIds: null as string | null,
};

vi.mock('@/lib/database/client', () => {
  return {
    prisma: {
      account: {
        findMany: vi.fn(async () => mockAccounts),
        findUnique: vi.fn(async ({ where }) => mockAccounts.find((a) => a.id === where.id)),
        count: vi.fn(async () => mockAccounts.length),
        update: vi.fn(async ({ where, data }) => {
          const acc = mockAccounts.find((a) => a.id === where.id);
          if (acc) {
            acc.quotaJson = data.quotaJson;
          }
          return acc;
        }),
      },
      settings: {
        findUnique: vi.fn(async () => mockSettings),
        upsert: vi.fn(async ({ update, create }) => {
          mockSettings = {
            id: 'global',
            routingMode: update.routingMode ?? create.routingMode,
            lockedAccountId: update.lockedAccountId ?? create.lockedAccountId,
            customAccountIds: update.customAccountIds ?? create.customAccountIds,
          };
          return mockSettings;
        }),
      },
    },
  };
});

vi.mock('@/lib/encryption', () => {
  return {
    decrypt: vi.fn((token) => token.replace('enc_', 'dec_')),
    encrypt: vi.fn((token) => `enc_${token}`),
  };
});

vi.mock('@/lib/antigravity/auth', () => {
  return {
    refreshAccessToken: vi.fn(async (refreshToken) => `access_token_for_${refreshToken}`),
  };
});

describe('Gateway Router Sequential Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the full routing lifecycle sequentially to avoid cross-test pollution', async () => {
    const { selectAndLockAccount, releaseAccount, writeRoutingSettings, markExhausted } = await import('@/lib/router/accountRouter');

    // 1. SMART MODE: Routes to Tier 1 first (acc1 has 1 day left, acc2 has 5 days left)
    {
      const res = await selectAndLockAccount('gemini');
      try {
        expect(res.accountId).toBe('acc1');
      } finally {
        releaseAccount(res.accountId);
      }
    }

    // 2. SMART MODE: If Tier 1 is empty/same-days, round-robin among Tier 2 (for anthropic pool, both are 5 days)
    {
      const res1 = await selectAndLockAccount('anthropic');
      try {
        expect(res1.accountId).toBe('acc1');
      } finally {
        releaseAccount(res1.accountId);
      }

      const res2 = await selectAndLockAccount('anthropic');
      try {
        expect(res2.accountId).toBe('acc2');
      } finally {
        releaseAccount(res2.accountId);
      }
    }

    // 3. ROUND-ROBIN MODE: Equal rotation across all healthy accounts
    {
      await writeRoutingSettings({
        mode: 'round-robin',
        lockedAccountId: null,
        customAccountIds: [],
      });

      const res1 = await selectAndLockAccount('gemini');
      try {
        // rrIndex.gemini was 1 after step 1, so (1 % 2) = 1 (acc2)
        expect(res1.accountId).toBe('acc2');
      } finally {
        releaseAccount(res1.accountId);
      }

      const res2 = await selectAndLockAccount('gemini');
      try {
        // rrIndex.gemini now 2, so (2 % 2) = 0 (acc1)
        expect(res2.accountId).toBe('acc1');
      } finally {
        releaseAccount(res2.accountId);
      }
    }

    // 4. LOCKED MODE: Always select locked account
    {
      await writeRoutingSettings({
        mode: 'locked',
        lockedAccountId: 'acc2',
        customAccountIds: [],
      });

      const res = await selectAndLockAccount('gemini');
      try {
        expect(res.accountId).toBe('acc2');
      } finally {
        releaseAccount(res.accountId);
      }

      // Mark it exhausted
      await markExhausted('acc2', 'gemini');

      // Next locked request should reject as the account is exhausted
      await expect(selectAndLockAccount('gemini')).rejects.toThrow();
    }
  });
});
