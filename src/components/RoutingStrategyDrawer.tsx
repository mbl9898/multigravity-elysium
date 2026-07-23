// src/components/RoutingStrategyDrawer.tsx
// Settings dialog for configuring the Elysium API gateway routing strategy.
// Provides 4 modes: Smart (default), Round-Robin, Locked, and Custom.
//
// Rendered in the dashboard header. Persists settings via PUT /api/settings.
'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Account } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type RoutingMode = 'smart' | 'round-robin' | 'locked' | 'custom';

interface RoutingSettings {
  mode: RoutingMode;
  lockedAccountId: string | null;
  customAccountIds: string[];
}

const MODE_CONFIG = {
  smart: {
    icon: '🧠',
    label: 'Smart Priority',
    description: 'Burns expiring quota first, then rotates. Maximises total quota utilisation.',
  },
  'round-robin': {
    icon: '🔄',
    label: 'Round Robin',
    description: 'Equal rotation across all healthy accounts. Distributes load evenly.',
  },
  locked: {
    icon: '🔒',
    label: 'Locked Account',
    description: 'Always use one specific account. Returns an error if it is exhausted.',
  },
  custom: {
    icon: '🎛',
    label: 'Custom Pool',
    description: 'You pick which accounts to include. Round-robin within your selection.',
  },
} as const;

// ─── Badge (shown in header) ──────────────────────────────────────────────────

export function RoutingStrategyBadge({
  settings,
  accounts,
}: {
  settings: RoutingSettings | null;
  accounts: Account[];
}) {
  if (!settings) return null;

  const mode = settings.mode;
  const cfg = MODE_CONFIG[mode];

  let label: string = cfg.label;
  if (mode === 'locked' && settings.lockedAccountId) {
    const acct = accounts.find((a) => a.id === settings.lockedAccountId);
    label = acct ? `🔒 ${acct.email.split('@')[0]}` : '🔒 Locked';
  } else if (mode === 'custom') {
    label = `🎛 ${settings.customAccountIds.length} accounts`;
  } else {
    label = `${cfg.icon} ${cfg.label}`;
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/80 border border-slate-700/60 px-3 py-1 text-xs font-medium text-slate-300 select-none">
      {label}
    </span>
  );
}

// ─── Dialog / Modal ───────────────────────────────────────────────────────────

export function RoutingStrategyDrawer({ accounts }: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RoutingSettings>({
    mode: 'smart',
    lockedAccountId: null,
    customAccountIds: [],
  });
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const { data: settings } = useQuery<RoutingSettings>({
    queryKey: ['routing-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to load settings');
      return res.json() as Promise<RoutingSettings>;
    },
    staleTime: 30_000,
  });

  const handleOpen = useCallback(() => {
    if (settings) setDraft({ ...settings });
    setOpen(true);
  }, [settings]);

  const showToast = useCallback((type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const saveMutation = useMutation({
    mutationFn: async (s: RoutingSettings) => {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: s.mode,
          lockedAccountId: s.lockedAccountId,
          customAccountIds: s.customAccountIds,
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? 'Save failed');
      }
      return res.json() as Promise<RoutingSettings>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['routing-settings'] });
      showToast('success', 'Routing strategy saved');
      setOpen(false);
    },
    onError: (err: Error) => {
      showToast('error', err.message);
    },
  });

  const healthyAccounts = accounts.filter((a) => a.health === 'healthy');

  return (
    <>
      {/* Trigger button */}
      <button
        id="routing-strategy-btn"
        onClick={handleOpen}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-700/60 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700/80 hover:text-white transition-colors"
        title="Configure routing strategy"
      >
        {settings ? (
          <RoutingStrategyBadge settings={settings} accounts={accounts} />
        ) : (
          <span>⚙ Gateway</span>
        )}
      </button>

      {/* Centered Dialog Modal */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) setOpen(false); else setOpen(true); }}>
        <DialogContent
          showCloseButton={false}
          className="w-full max-w-[480px] p-0 bg-slate-950 border border-slate-800/85 flex flex-col overflow-hidden gap-0 rounded-2xl shadow-2xl text-slate-200"
        >
          {/* Header */}
          <DialogHeader className="flex-row items-center justify-between px-6 pt-6 pb-5 gap-0 border-b border-slate-900/80 bg-slate-950 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0">
                <span className="text-base">⚙️</span>
              </div>
              <div>
                <DialogTitle className="text-sm font-semibold text-white leading-tight !text-sm">Gateway Routing Strategy</DialogTitle>
                <DialogDescription className="text-[11px] text-slate-500 mt-0.5 !text-[11px]">
                  Controls how Elysium picks an account for each request
                </DialogDescription>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-900 hover:text-slate-350 transition-colors flex-shrink-0"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </DialogHeader>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 max-h-[60vh] min-h-0 bg-slate-950/40">
            {/* Mode cards */}
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Mode</p>
              <div className="grid grid-cols-2 gap-2.5">
                {(Object.entries(MODE_CONFIG) as [RoutingMode, typeof MODE_CONFIG[RoutingMode]][]).map(
                  ([mode, cfg]) => {
                    const selected = draft.mode === mode;
                    return (
                      <button
                        key={mode}
                        id={`routing-mode-${mode}`}
                        onClick={() => setDraft((d) => ({ ...d, mode }))}
                        className={`flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-all duration-150 ${
                          selected
                            ? 'border-indigo-500 bg-indigo-950/40 text-white shadow-lg shadow-indigo-950/30'
                            : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-200'
                        }`}
                      >
                        <span className="text-base">{cfg.icon}</span>
                        <span className="text-xs font-semibold leading-tight">{cfg.label}</span>
                        <span className="text-[10px] leading-relaxed opacity-60 mt-1">{cfg.description}</span>
                      </button>
                    );
                  },
                )}
              </div>
            </div>

            {/* Locked account selector */}
            {draft.mode === 'locked' && (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Pinned Account</p>
                {healthyAccounts.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">No healthy accounts available.</p>
                ) : (
                  <select
                    id="locked-account-select"
                    value={draft.lockedAccountId ?? ''}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, lockedAccountId: e.target.value || null }))
                    }
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3.5 py-2.5 text-xs text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20 transition-all cursor-pointer"
                  >
                    <option value="">— Select an account —</option>
                    {healthyAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nickname ?? a.email}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-[10px] text-amber-500/80 flex items-center gap-1.5 mt-2">
                  <span>⚠️</span>
                  <span>If this account is exhausted, requests will return 503. No fallback.</span>
                </p>
              </div>
            )}

            {/* Custom account checklist */}
            {draft.mode === 'custom' && (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">
                  Pool Accounts ({draft.customAccountIds.length} selected)
                </p>
                {healthyAccounts.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">No healthy accounts available.</p>
                ) : (
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {healthyAccounts.map((a) => {
                      const checked = draft.customAccountIds.includes(a.id);
                      return (
                        <label
                          key={a.id}
                          className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 cursor-pointer transition-all ${
                            checked
                              ? 'border-indigo-500 bg-indigo-950/30'
                              : 'border-slate-850 bg-slate-900/40 hover:border-slate-700'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                customAccountIds: e.target.checked
                                  ? [...d.customAccountIds, a.id]
                                  : d.customAccountIds.filter((id) => id !== a.id),
                              }))
                            }
                            className="rounded border-slate-700 bg-slate-800 accent-indigo-500"
                            id={`custom-acct-${a.id}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-slate-200 truncate">
                              {a.nickname ?? a.email}
                            </p>
                            {a.nickname && (
                              <p className="text-[10px] text-slate-650 truncate">{a.email}</p>
                            )}
                          </div>
                          <span
                            className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                              a.health === 'healthy' ? 'bg-emerald-455' : 'bg-red-400'
                            }`}
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
                {draft.customAccountIds.length === 0 && (
                  <p className="text-[10px] text-amber-500/80 flex items-center gap-1.5 mt-2">
                    <span>⚠️</span>
                    <span>Select at least one account for the pool.</span>
                  </p>
                )}
              </div>
            )}

            {/* Info box for smart mode */}
            {draft.mode === 'smart' && (
              <div className="rounded-xl border border-indigo-900/35 bg-indigo-950/20 p-4 text-[11px] text-indigo-300/80 space-y-1.5 leading-relaxed">
                <p className="font-semibold text-indigo-200">How Smart Priority works</p>
                <ul className="space-y-1 list-disc list-inside opacity-90">
                  <li>Accounts with weekly quota resets in <strong className="text-white">≤ 2 days</strong> are served first.</li>
                  <li>Round-robin within urgent group, then standard group.</li>
                  <li>Pool type matches requested model (Gemini vs Claude).</li>
                </ul>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-slate-900/80 bg-slate-950 flex-shrink-0 flex items-center justify-end gap-3">
            <button
              onClick={() => setOpen(false)}
              className="rounded-xl border border-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors"
            >
              Cancel
            </button>
            <button
              id="save-routing-strategy-btn"
              onClick={() => saveMutation.mutate(draft)}
              disabled={
                saveMutation.isPending ||
                (draft.mode === 'locked' && !draft.lockedAccountId) ||
                (draft.mode === 'custom' && draft.customAccountIds.length === 0)
              }
              className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed px-5 py-2.5 text-xs font-semibold text-white transition-all shadow-lg shadow-indigo-900/40"
            >
              {saveMutation.isPending ? (
                <>
                  <Spinner />
                  Saving…
                </>
              ) : (
                'Save Strategy'
              )}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-[10000] flex items-center gap-2.5 rounded-xl border px-4 py-3 text-xs font-semibold shadow-2xl ${
            toast.type === 'success'
              ? 'border-emerald-700/50 bg-emerald-950/95 text-emerald-300'
              : 'border-red-700/50 bg-red-950/95 text-red-300'
          }`}
          style={{ animation: 'rsSlideUp 0.25s cubic-bezier(0.16,1,0.3,1)' }}
        >
          {toast.type === 'success' ? '✓' : '✗'} {toast.msg}
        </div>
      )}
      <style>{`@keyframes rsSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
