// src/test/quota-parsing.test.ts
// Unit tests for fetchAccountQuota bucket parsing logic.
// fetchAccountQuota(accessToken, projectId) makes exactly ONE fetch call
// to retrieveUserQuotaSummary — loadCodeAssist is called upstream by the route handler.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchAccountQuota } from '@/lib/antigravity/quota';

vi.stubGlobal('fetch', vi.fn());
const mockFetch = vi.mocked(fetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function makeOkResponse(body: object) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => message,
  } as unknown as Response;
}

describe('fetchAccountQuota — quota parsing', () => {
  it('correctly maps gemini and anthropic buckets (5h + weekly)', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: '5h', window: '5h', remainingFraction: 1.0, resetTime: '2026-07-12T10:00:00Z' },
            { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.66, resetTime: '2026-07-15T00:00:00Z' },
          ],
        },
        {
          displayName: 'Claude / Anthropic',
          buckets: [
            { bucketId: '5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-07-12T10:00:00Z' },
            { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.0, resetTime: '2026-07-15T00:00:00Z' },
          ],
        },
      ],
    }));

    const quota = await fetchAccountQuota('fake-access-token', 'proj-123');

    // Gemini
    expect(quota.gemini.remaining5h).toBe(1.0);
    expect(quota.gemini.remaining7d).toBe(0.66);
    expect(quota.gemini.weeklyStatus).toBe('ok');
    expect(quota.gemini.resetTime5h).toBe('2026-07-12T10:00:00Z');

    // Anthropic — weekly exhausted
    expect(quota.anthropic.remaining5h).toBe(0.5);
    expect(quota.anthropic.remaining7d).toBe(0.0);
    expect(quota.anthropic.weeklyStatus).toBe('exhausted');
  });

  it('sets weeklyStatus to ok when remaining7d > 0', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ bucketId: 'weekly', window: 'weekly', remainingFraction: 0.01 }],
        },
      ],
    }));

    const quota = await fetchAccountQuota('token', 'proj');
    expect(quota.gemini.weeklyStatus).toBe('ok');
  });

  it('sets weeklyStatus to exhausted when remaining7d is exactly 0', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ bucketId: 'weekly', window: 'weekly', remainingFraction: 0 }],
        },
      ],
    }));

    const quota = await fetchAccountQuota('token', 'proj');
    expect(quota.gemini.weeklyStatus).toBe('exhausted');
  });

  it('returns null fractions when no groups are returned', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ groups: [] }));

    const quota = await fetchAccountQuota('token', 'proj');
    expect(quota.gemini.remaining5h).toBeNull();
    expect(quota.gemini.remaining7d).toBeNull();
    expect(quota.anthropic.remaining5h).toBeNull();
    expect(quota.gemini.weeklyStatus).toBe('unknown');
  });

  it('classifies groups by displayName matching "claude" as anthropic', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      groups: [
        {
          displayName: 'claude-sonnet',
          buckets: [{ bucketId: '5h', window: '5h', remainingFraction: 0.8 }],
        },
      ],
    }));

    const quota = await fetchAccountQuota('token', 'proj');
    expect(quota.anthropic.remaining5h).toBe(0.8);
    expect(quota.gemini.remaining5h).toBeNull();
  });

  it('throws when the quota summary endpoint returns a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403, 'Forbidden'));

    await expect(fetchAccountQuota('bad-token', 'proj')).rejects.toThrow('retrieveUserQuotaSummary failed');
  });
});
