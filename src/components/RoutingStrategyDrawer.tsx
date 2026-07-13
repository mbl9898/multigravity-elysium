// src/components/RoutingStrategyDrawer.tsx
// Settings drawer for configuring the Elysium API gateway routing strategy.
// Provides 4 modes: Smart (default), Round-Robin, Locked, and Custom.
//
// Rendered in the dashboard header. Persists settings via PUT /api/settings.
'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Account } from '@/types';


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
    description: 'Burns quota expiring within 2 days first, then rotates. Maximises total quota utilisation.',
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

// ─── Drawer ───────────────────────────────────────────────────────────────────

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

  // Sync draft when the drawer opens — done in the open handler, not an effect
  // to avoid the "setState in effect" lint rule.
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

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Drawer */}
      <div
        className={`fixed right-0 top-0 z-50 h-full w-full max-w-md transform bg-slate-900 border-l border-slate-700/60 shadow-2xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        } flex flex-col`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700/60 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Gateway Routing Strategy</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Controls how Elysium picks an account for each request
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Mode cards */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Mode</p>
            <div className="grid grid-cols-2 gap-2">
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
                          ? 'border-indigo-500/70 bg-indigo-950/40 text-white shadow-sm shadow-indigo-900/30'
                          : 'border-slate-700/60 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-200'
                      }`}
                    >
                      <span className="text-lg">{cfg.icon}</span>
                      <span className="text-xs font-semibold leading-tight">{cfg.label}</span>
                      <span className="text-[11px] leading-tight opacity-70">{cfg.description}</span>
                    </button>
                  );
                },
              )}
            </div>
          </div>

          {/* Locked account selector */}
          {draft.mode === 'locked' && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Pinned Account</p>
              {healthyAccounts.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No healthy accounts available.</p>
              ) : (
                <select
                  id="locked-account-select"
                  value={draft.lockedAccountId ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, lockedAccountId: e.target.value || null }))
                  }
                  className="w-full rounded-lg border border-slate-700/60 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="">— Select an account —</option>
                  {healthyAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname ?? a.email}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-[11px] text-amber-400/80">
                ⚠ If this account is exhausted, requests will return 503. No automatic fallback.
              </p>
            </div>
          )}

          {/* Custom account checklist */}
          {draft.mode === 'custom' && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Pool Accounts ({draft.customAccountIds.length} selected)
              </p>
              {healthyAccounts.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No healthy accounts available.</p>
              ) : (
                <div className="space-y-1.5">
                  {healthyAccounts.map((a) => {
                    const checked = draft.customAccountIds.includes(a.id);
                    return (
                      <label
                        key={a.id}
                        className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                          checked
                            ? 'border-indigo-500/50 bg-indigo-950/30'
                            : 'border-slate-700/50 bg-slate-800/50 hover:border-slate-600'
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
                          className="rounded border-slate-600 bg-slate-700 accent-indigo-500"
                          id={`custom-acct-${a.id}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-200 truncate">
                            {a.nickname ?? a.email}
                          </p>
                          {a.nickname && (
                            <p className="text-[11px] text-slate-500 truncate">{a.email}</p>
                          )}
                        </div>
                        <span
                          className={`h-2 w-2 rounded-full flex-shrink-0 ${
                            a.health === 'healthy' ? 'bg-emerald-400' : 'bg-red-400'
                          }`}
                        />
                      </label>
                    );
                  })}
                </div>
              )}
              {draft.customAccountIds.length === 0 && (
                <p className="text-[11px] text-amber-400/80">
                  ⚠ Select at least one account for the pool.
                </p>
              )}
            </div>
          )}

          {/* Info box for smart mode */}
          {draft.mode === 'smart' && (
            <div className="rounded-lg border border-indigo-900/40 bg-indigo-950/20 p-4 text-[12px] text-indigo-300/80 space-y-1.5">
              <p className="font-semibold text-indigo-200">How Smart Priority works</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Accounts whose weekly quota resets in <strong className="text-white">≤ 2 days</strong> are served first — use it before you lose it.</li>
                <li>Round-robin within the urgent group, then round-robin in the normal group.</li>
                <li>Pool type is scoped to the model: Gemini requests use only Gemini quota, Claude only Anthropic quota.</li>
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700/60 px-6 py-4 flex items-center justify-between gap-3">
          <button
            onClick={() => setOpen(false)}
            className="rounded-xl border border-slate-700/60 px-4 py-2 text-sm text-slate-400 hover:text-white hover:border-slate-600 transition-colors"
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
            className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed px-5 py-2 text-sm font-semibold text-white transition-colors shadow-lg shadow-indigo-900/30"
          >
            {saveMutation.isPending ? (
              <>
                <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving…
              </>
            ) : (
              'Save Strategy'
            )}
          </button>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-xl animate-in slide-in-from-bottom-4 duration-300 ${
            toast.type === 'success'
              ? 'border-emerald-700/60 bg-emerald-950/90 text-emerald-300'
              : 'border-red-700/60 bg-red-950/90 text-red-300'
          }`}
        >
          {toast.type === 'success' ? '✓' : '✗'} {toast.msg}
        </div>
      )}
    </>
  );
}
