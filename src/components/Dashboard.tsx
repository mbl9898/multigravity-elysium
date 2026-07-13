// src/components/Dashboard.tsx
// Main dashboard — fetches all accounts and renders AccountCards.
// Uses TanStack Query for automatic background polling.
'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AccountCard } from './AccountCard';
import { RoutingStrategyDrawer } from './RoutingStrategyDrawer';
import type { Account } from '@/types';

interface AccountsResponse {
  accounts: Account[];
}

interface V2StatusResponse {
  email: string;
  name: string;
  hasToken: boolean;
}

export type SortMode =
  | 'email'
  | 'gemini-weekly-reset'
  | 'anthropic-weekly-reset'
  | 'gemini-5h-reset'
  | 'anthropic-5h-reset';

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
    const isExhausted = type === '5h' 
      ? (p.remaining5h !== null && p.remaining5h <= 0) 
      : (p.weeklyStatus === 'exhausted');
    return isExhausted ? Infinity : 0;
  }

  const target = new Date(resetTimeStr).getTime();
  const diffMs = target - now;
  return diffMs <= 0 ? 0 : diffMs;
}

const getNow = () => Date.now();

function sortByEmail(accounts: Account[]): Account[] {
  return [...accounts].sort((a, b) => a.email.localeCompare(b.email));
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const [v2ActiveEmail, setV2ActiveEmail] = useState<string | null>(null);
  const [v2SwitchingId, setV2SwitchingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('email');
  const [now, setNow] = useState(getNow);

  // Load persistent sort mode on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('dashboard-sort-mode');
      if (saved) {
        const validModes: SortMode[] = [
          'email',
          'gemini-weekly-reset',
          'anthropic-weekly-reset',
          'gemini-5h-reset',
          'anthropic-5h-reset',
        ];
        if (validModes.includes(saved as SortMode)) {
          setTimeout(() => {
            setSortMode(saved as SortMode);
          }, 0);
        }
      }
    } catch (e) {
      console.error('Failed to load sort mode from localStorage:', e);
    }
  }, []);

  const handleSortChange = (newMode: SortMode) => {
    setSortMode(newMode);
    try {
      localStorage.setItem('dashboard-sort-mode', newMode);
    } catch (e) {
      console.error('Failed to save sort mode to localStorage:', e);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(getNow());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const { data, isLoading, error } = useQuery<AccountsResponse>({
    queryKey: ['accounts'],
    queryFn: async () => {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error('Failed to fetch accounts');
      return res.json() as Promise<AccountsResponse>;
    },
  });

  // Fetch current V2 active account on load
  useQuery<V2StatusResponse>({
    queryKey: ['v2-status'],
    queryFn: async () => {
      const res = await fetch('/api/v2/switch-account');
      if (!res.ok) throw new Error('V2 status failed');
      const d = await res.json() as V2StatusResponse;
      setV2ActiveEmail(d.email);
      return d;
    },
    retry: false,
    staleTime: 30_000,
  });

  const refreshMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const res = await fetch(`/api/quota/${accountId}`, { method: 'POST' });
      if (!res.ok) throw new Error('Refresh failed');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const res = await fetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const v2SwitchMutation = useMutation({
    mutationFn: async (accountId: string) => {
      setV2SwitchingId(accountId);
      const res = await fetch('/api/v2/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      const d = await res.json() as { success?: boolean; email?: string; error?: string; message?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? 'Switch failed');
      return d;
    },
    onSuccess: (d) => {
      if (d.email) setV2ActiveEmail(d.email);
      setV2SwitchingId(null);
    },
    onError: () => { setV2SwitchingId(null); },
  });

  const [pingingId, setPingingId] = useState<string | null>(null);
  const pingMutation = useMutation({
    mutationFn: async (accountId: string) => {
      setPingingId(accountId);
      const res = await fetch(`/api/accounts/${accountId}/ping`, { method: 'POST' });
      if (!res.ok) throw new Error('Ping failed');
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setPingingId(null);
    },
    onError: () => { setPingingId(null); },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-3 text-slate-500">
          <svg className="h-5 w-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span>Loading accounts…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl bg-red-950/30 border border-red-800/40 p-6 text-center text-red-400 text-sm">
        Failed to load accounts. Make sure the server is running.
      </div>
    );
  }

  const allAccounts = data?.accounts ?? [];

  if (allAccounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <div>
          <p className="text-slate-300 font-medium text-lg">No accounts connected</p>
          <p className="text-slate-500 text-sm mt-1">Add your first Antigravity account to start monitoring quota.</p>
        </div>
        <a
          href="/api/auth/login"
          id="add-first-account-btn"
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-5 py-2.5 text-sm transition-colors shadow-lg shadow-indigo-900/30"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Connect Account
        </a>
      </div>
    );
  }

  // Filter accounts
  const filteredAccounts = allAccounts.filter((account) => {
    const search = searchTerm.trim().toLowerCase();
    if (!search) return true;
    return (
      account.email.toLowerCase().includes(search) ||
      (account.nickname && account.nickname.toLowerCase().includes(search))
    );
  });

  // Sort accounts
  const sortedAccounts = [...filteredAccounts].sort((a, b) => {
    if (sortMode === 'email') {
      return a.email.localeCompare(b.email);
    }

    let valA = 0;
    let valB = 0;

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

    if (valA === valB) {
      return a.email.localeCompare(b.email);
    }
    if (valA === Infinity) return 1;
    if (valB === Infinity) return -1;
    return valA - valB;
  });

  const drawerAccounts = sortByEmail(allAccounts);

  return (
    <>
      {/* Routing strategy drawer — rendered at top level so the fixed overlay works correctly */}
      <RoutingStrategyDrawer accounts={drawerAccounts} />

      {/* ── Search & Sort Toolbar ── */}
      <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center justify-between bg-slate-900/40 border border-slate-800/60 rounded-xl p-3.5 backdrop-blur-sm shadow-lg shadow-black/10">
        <div className="relative flex-1 max-w-md group">
          <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 group-focus-within:text-indigo-400 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </span>
          <input
            type="text"
            placeholder="Search by email or nickname..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-8 py-2 bg-slate-950/40 hover:bg-slate-950/60 focus:bg-slate-950/90 border border-slate-800/80 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/50 transition-all"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-350 transition-colors"
              title="Clear search"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="dashboard-sort" className="text-xs font-medium text-slate-400 select-none flex items-center gap-1.5 shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
            Sort by
          </label>
          <div className="relative">
            <select
              id="dashboard-sort"
              value={sortMode}
              onChange={(e) => handleSortChange(e.target.value as SortMode)}
              className="appearance-none bg-slate-950/40 hover:bg-slate-950/60 border border-slate-800/80 rounded-xl pl-3 pr-8 py-2 text-xs text-slate-300 font-medium focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/50 transition-all cursor-pointer"
            >
              <option value="email">Alphabetical (A-Z)</option>
              <option value="gemini-weekly-reset">Gemini Weekly Reset (Soonest)</option>
              <option value="anthropic-weekly-reset">Anthropic Weekly Reset (Soonest)</option>
              <option value="gemini-5h-reset">Gemini 5h Reset (Soonest)</option>
              <option value="anthropic-5h-reset">Anthropic 5h Reset (Soonest)</option>
            </select>
            <div className="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none text-slate-500">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {sortedAccounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center space-y-4 bg-slate-900/10 border border-slate-800/40 rounded-2xl">
          <p className="text-slate-400 text-sm">No accounts found matching &quot;{searchTerm}&quot;</p>
          <button
            onClick={() => setSearchTerm('')}
            className="text-xs bg-slate-800/60 hover:bg-slate-800 text-slate-300 hover:text-slate-200 border border-slate-700/50 px-3 py-1.5 rounded-lg transition-colors"
          >
            Clear Search
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {sortedAccounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onRefresh={(id) => refreshMutation.mutate(id)}
              onDelete={(id) => deleteMutation.mutate(id)}
              isRefreshing={
                refreshMutation.isPending && refreshMutation.variables === account.id
              }
              onActivateV2={(id) => v2SwitchMutation.mutate(id)}
              isV2Active={v2ActiveEmail === account.email}
              isV2Switching={v2SwitchingId === account.id}
              v2Error={
                v2SwitchMutation.isError && v2SwitchingId === null && v2SwitchMutation.variables === account.id
                  ? String(v2SwitchMutation.error)
                  : null
              }
              onPing={(id) => pingMutation.mutate(id)}
              isPinging={pingingId === account.id}
            />
          ))}
        </div>
      )}
    </>
  );
}
