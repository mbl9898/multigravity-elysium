// src/components/Dashboard.tsx
// Main dashboard — fetches all accounts and renders AccountCards.
// Uses TanStack Query for automatic background polling.
'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AccountCard } from './AccountCard';
import type { Account } from '@/types';

interface AccountsResponse {
  accounts: Account[];
}

interface V2StatusResponse {
  email: string;
  name: string;
  hasToken: boolean;
}

function sortByEmail(accounts: Account[]): Account[] {
  return [...accounts].sort((a, b) => a.email.localeCompare(b.email));
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const [v2ActiveEmail, setV2ActiveEmail] = useState<string | null>(null);
  const [v2SwitchingId, setV2SwitchingId] = useState<string | null>(null);

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

  const accounts = sortByEmail(data?.accounts ?? []);

  if (accounts.length === 0) {
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

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
      {accounts.map((account) => (
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
  );
}
