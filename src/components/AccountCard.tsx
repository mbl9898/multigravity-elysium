// src/components/AccountCard.tsx
// The main card displayed per account on the dashboard.
// Shows: email, nickname, tier, Gemini quota, Anthropic quota,
//        5-hour bars, weekly status, reset countdowns, health, last updated.
'use client';

import { useState, useEffect } from 'react';
import { QuotaBar } from './QuotaBar';
import { CountdownTimer } from './CountdownTimer';
import { Badge } from './ui/badge';
import type { Account, PoolQuota } from '@/types';

// ─── Sub-components ───────────────────────────────────────────────────────────

function HealthDot({ health, lastChecked, isStale, now }: {
  health: Account['health'];
  lastChecked: string | null;
  isStale: boolean;
  now: number;
}) {
  const colors: Record<Account['health'], string> = {
    healthy: 'bg-emerald-400 shadow-emerald-400/50',
    degraded: 'bg-amber-400 shadow-amber-400/50',
    error: 'bg-red-400 shadow-red-400/50',
    unauthenticated: 'bg-slate-500',
  };
  const labels: Record<Account['health'], string> = {
    healthy: 'Healthy',
    degraded: 'Degraded',
    error: 'Error',
    unauthenticated: 'Not authenticated',
  };

  const timeStr = lastChecked
    ? (() => {
        const diffMs = now - new Date(lastChecked).getTime();
        const diffSec = Math.floor(diffMs / 1000);
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        return `${Math.floor(diffMin / 60)}h ago`;
      })()
    : null;

  return (
    <div className="flex items-center gap-1.5" title={labels[health]}>
      <span className={`inline-block h-2 w-2 rounded-full shadow-sm flex-shrink-0 ${colors[health]}`} />
      <span className={`text-xs ${isStale ? 'text-amber-500' : 'text-slate-500'}`}>
        {labels[health]}{timeStr ? ` · ${timeStr}` : ''}{isStale ? ' ⚠' : ''}
      </span>
    </div>
  );
}

function PoolSection({
  label,
  pool,
  accountId,
}: {
  label: string;
  pool: PoolQuota | null;
  accountId: string;
}) {
  const displayPool = label === 'Gemini' ? 'gemini' : 'anthropic';

  const weeklyStatusRow = () => {
    if (!pool) return null;
    if (pool.weeklyStatus === 'unknown') {
      return <span className="text-xs text-slate-600 italic">Weekly: fetching…</span>;
    }
    if (pool.weeklyStatus === 'ok') {
      return (
        <div className="flex items-center justify-between w-full text-xs">
          <span className="text-emerald-400">✓ Weekly OK</span>
          {pool.resetTime7d && (
            <span className="text-slate-500">
              Resets in{' '}
              <CountdownTimer resetTime={pool.resetTime7d} className="text-slate-300 font-medium" />
            </span>
          )}
        </div>
      );
    }
    if (pool.weeklyStatus === 'exhausted') {
      return (
        <div className="flex items-center justify-between w-full text-xs">
          <span className="text-red-400 font-semibold">Weekly Exhausted</span>
          {pool.resetTime7d && (
            <span className="text-slate-500">
              Resets in{' '}
              <CountdownTimer resetTime={pool.resetTime7d} className="text-red-400 font-medium" />
            </span>
          )}
        </div>
      );
    }
  };

  // For the weekly bar:
  // - 'unknown'   → null  (gray dash — scheduler is working on it)
  // - 'ok' + fraction known  → the actual fraction
  // - 'ok' + fraction null   → null  (green '✓ Weekly OK' text shown, but bar shows '—' — honest)
  // - 'exhausted' → 0.0 (red empty bar)
  const weeklyBarValue: number | null =
    pool?.weeklyStatus === 'unknown'
      ? null
      : pool?.weeklyStatus === 'exhausted'
        ? 0.0
        : pool?.remaining7d ?? null; // ok: use real fraction if known, null if not

  return (
    <div className="space-y-3">
      {/* Pool header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">{label}</h3>
        {pool && pool.resetTime5h && (
          <div className="text-xs text-slate-500">
            Resets in{' '}
            <CountdownTimer resetTime={pool.resetTime5h} className="text-slate-300 font-medium" />
          </div>
        )}
      </div>

      {/* 5-hour bar */}
      <QuotaBar
        value={pool?.remaining5h ?? null}
        label="5-Hour"
        id={`${accountId}-${displayPool}-5h`}
        isBlocked={pool?.weeklyStatus === 'exhausted'}
      />

      {/* Weekly bar — always shown; null value renders as a skeleton/dash */}
      <QuotaBar
        value={weeklyBarValue}
        label="Weekly"
        id={`${accountId}-${displayPool}-7d`}
      />

      {/* Weekly status text */}
      <div className="flex items-center pt-0.5 w-full">
        {weeklyStatusRow()}
      </div>
    </div>
  );
}

// ─── Main AccountCard ─────────────────────────────────────────────────────────

interface AccountCardProps {
  account: Account;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  isRefreshing: boolean;
  onActivateV2: (id: string) => void;
  isV2Active: boolean;
  isV2Switching: boolean;
  v2Error: string | null;
  onPing: (id: string) => void;
  isPinging: boolean;
}

function timeAgo(isoString: string | null, now: number): string {
  if (!isoString) return 'never';
  const diffMs = now - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

const getNow = () => Date.now();

export function AccountCard({ account, onRefresh, onDelete, isRefreshing, onActivateV2, isV2Active, isV2Switching, v2Error, onPing, isPinging }: AccountCardProps) {
  const [now, setNow] = useState(getNow);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(getNow());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // Stale warning: last check was more than 5 minutes ago
  const isStale =
    account.lastChecked &&
    now - new Date(account.lastChecked).getTime() > 5 * 60 * 1000;

  return (
    <article
      id={`account-card-${account.id}`}
      className="relative rounded-2xl border border-slate-700/60 bg-slate-800/50 backdrop-blur-sm p-5 space-y-5 hover:border-slate-600/80 transition-colors duration-200 shadow-xl shadow-black/20"
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-slate-100 truncate text-sm">
              {account.nickname ?? account.email}
            </p>
            {account.tier && (
              <Badge variant="secondary" className="text-xs shrink-0 bg-indigo-900/60 text-indigo-300 border-indigo-700/50">
                {account.tier}
              </Badge>
            )}
            {isV2Active && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 rounded-full px-2 py-0.5 shrink-0">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                V2 Active
              </span>
            )}
          </div>
          {account.nickname && (
            <p className="text-xs text-slate-500 truncate mt-0.5">{account.email}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            id={`refresh-btn-${account.id}`}
            onClick={() => onRefresh(account.id)}
            disabled={isRefreshing}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="Refresh quota now"
            aria-label="Refresh quota"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            id={`delete-btn-${account.id}`}
            onClick={() => {
              if (confirm(`Remove ${account.email}?`)) onDelete(account.id);
            }}
            className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-900/20 transition-all"
            title="Remove account"
            aria-label="Remove account"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Quota Sections ── */}
      {account.quota ? (
        <div className="space-y-5">
          <div className="border-t border-slate-700/50 pt-4">
            <PoolSection
              label="Gemini"
              pool={account.quota.gemini}
              accountId={account.id}
            />
          </div>
          <div className="border-t border-slate-700/50 pt-4">
            <PoolSection
              label="Anthropic"
              pool={account.quota.anthropic}
              accountId={account.id}
            />
          </div>
        </div>
      ) : (
        <div className="border-t border-slate-700/50 pt-4">
          <p className="text-sm text-slate-500 italic text-center py-3">
            {account.health === 'error'
              ? 'Failed to fetch quota'
              : 'Fetching quota…'}
          </p>
        </div>
      )}

      {/* ── Error Banner ── */}
      {(account.lastError || v2Error) && (
        <div className="rounded-lg bg-red-950/40 border border-red-800/40 px-3 py-2 text-xs text-red-400">
          {v2Error ?? account.lastError}
        </div>
      )}

      {/* ── Footer ── */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-700/40 gap-2">
        {/* Left: health + last-refresh time */}
        <HealthDot
          health={account.health}
          lastChecked={account.lastChecked}
          isStale={!!isStale}
          now={now}
        />

        {/* Right: action buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Activate in V2 — most important, shown first */}
          {!isV2Active && (
            <button
              id={`v2-activate-btn-${account.id}`}
              onClick={() => onActivateV2(account.id)}
              disabled={isV2Switching}
              title="Switch Antigravity V2 to this account"
              className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-lg border transition-all
                disabled:opacity-40 disabled:cursor-not-allowed
                bg-violet-950/40 hover:bg-violet-900/50 text-violet-300 hover:text-violet-200
                border-violet-700/40 hover:border-violet-600/60"
            >
              {isV2Switching ? (
                <>
                  <svg className="h-2.5 w-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Switching…
                </>
              ) : (
                <>
                  <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 3M21 7.5H7.5" />
                  </svg>
                  Activate in V2
                </>
              )}
            </button>
          )}

          {/* Ping button — integrates status as colored dot */}
          <button
            id={`ping-btn-${account.id}`}
            onClick={() => onPing(account.id)}
            disabled={isPinging}
            title={`Ping Gemini + Claude to start 5h countdown${account.lastPingAt ? ` · Last: ${timeAgo(account.lastPingAt, now)}` : ' · Never pinged'}`}
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg border transition-all
              disabled:opacity-40 disabled:cursor-not-allowed
              bg-slate-800/60 hover:bg-slate-700/60 text-slate-400 hover:text-slate-200
              border-slate-700/50 hover:border-slate-600/60"
          >
            {isPinging ? (
              <>
                <svg className="h-2.5 w-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Pinging…
              </>
            ) : (() => {
              // Compute ping status inline for the dot color
              const pingAgeMs = account.lastPingAt
                ? now - new Date(account.lastPingAt).getTime()
                : null;
              const pingIsActive = pingAgeMs !== null && pingAgeMs < (4 * 60 + 58) * 60_000;
              const pingIsError = account.lastPingStatus === 'error';
              const dotColor = !account.lastPingAt
                ? 'bg-slate-600'
                : pingIsError
                ? 'bg-red-400'
                : pingIsActive
                ? 'bg-emerald-400'
                : 'bg-amber-400';
              const pingLabel = !account.lastPingAt
                ? 'Ping'
                : pingIsError
                ? 'Retry ping'
                : `Ping`;
              return (
                <>
                  <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${dotColor} ${pingIsActive ? 'animate-pulse' : ''}`} />
                  {pingLabel}
                </>
              );
            })()}
          </button>
        </div>
      </div>
    </article>
  );
}
