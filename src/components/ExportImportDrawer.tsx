// src/components/ExportImportDrawer.tsx
// Dialog for exporting and importing Multigravity Elysium accounts.
// Rendered via Dialog onto document.body to prevent layout styling issues.
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type Tab = 'export' | 'import';

interface Toast {
  type: 'success' | 'error';
  msg: string;
}

interface AccountRow {
  id: string;
  email: string;
  nickname: string | null;
  tier?: string | null;
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function Avatar({ email, selected }: { email: string; selected: boolean }) {
  return (
    <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all duration-150 ${selected ? 'bg-indigo-500 text-white' : 'bg-slate-700 text-slate-400'}`}>
      {email.charAt(0).toUpperCase()}
    </div>
  );
}

function EyeIcon({ show }: { show: boolean }) {
  return show ? (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  ) : (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}

export function ExportImportDrawer() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('export');
  const [toast, setToast] = useState<Toast | null>(null);

  // Accounts
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Export fields
  const [exportPass, setExportPass] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [exportPassErr, setExportPassErr] = useState('');
  const [exportConfirmErr, setExportConfirmErr] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [showExportPass, setShowExportPass] = useState(false);
  const [showExportConfirm, setShowExportConfirm] = useState(false);

  // Import fields
  const [importPass, setImportPass] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [showImportPass, setShowImportPass] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Toast helper
  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4500);
  };

  // Fetch accounts when modal opens
  const fetchAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { accounts: AccountRow[] };
      const rows = data.accounts ?? [];
      setAccounts(rows);
      setSelectedIds(new Set(rows.map((a) => a.id)));
    } catch { setAccounts([]); }
    finally { setAccountsLoading(false); }
  }, []);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        void fetchAccounts();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [open, fetchAccounts]);

  const handleClose = () => {
    setOpen(false);
    setExportPass(''); setExportConfirm(''); setExportPassErr(''); setExportConfirmErr('');
    setImportPass(''); setImportFile(null); setDragOver(false);
  };

  const toggleAccount = (id: string) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
      }
      return n;
    });

  const allSelected = accounts.length > 0 && selectedIds.size === accounts.length;
  const noneSelected = selectedIds.size === 0;

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    let valid = true;
    if (exportPass.length < 4) { setExportPassErr('Must be at least 4 characters.'); valid = false; } else setExportPassErr('');
    if (exportConfirm !== exportPass) { setExportConfirmErr('Passphrases do not match.'); valid = false; } else setExportConfirmErr('');
    if (noneSelected) { showToast('error', 'Select at least one account to export.'); return; }
    if (!valid) return;
    setExportLoading(true);
    try {
      const res = await fetch('/api/accounts/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: exportPass, accountIds: [...selectedIds] }),
      });
      const data = (await res.json()) as { bundle?: string; error?: string };
      if (!res.ok || !data.bundle) throw new Error(data.error ?? 'Export failed');
      const blob = new Blob([JSON.stringify({ bundle: data.bundle }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `multigravity-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('success', `${selectedIds.size} account${selectedIds.size !== 1 ? 's' : ''} exported`);
      setExportPass(''); setExportConfirm('');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Export failed');
    } finally { setExportLoading(false); }
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const handleImport = async () => {
    if (!importFile) { showToast('error', 'Please select an export file.'); return; }
    if (!importPass.trim()) { showToast('error', 'Please enter the passphrase.'); return; }
    setImportLoading(true);
    try {
      const parsed = JSON.parse(await importFile.text()) as { bundle?: string };
      if (!parsed.bundle) throw new Error('Invalid export file — missing bundle field.');
      const res = await fetch('/api/accounts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle: parsed.bundle, password: importPass }),
      });
      const data = (await res.json()) as { imported?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Import failed');
      showToast('success', `${data.imported ?? 0} imported · ${data.skipped ?? 0} skipped`);
      setImportPass(''); setImportFile(null);
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Import failed');
    } finally { setImportLoading(false); }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.name.endsWith('.json')) setImportFile(file);
    else showToast('error', 'Please drop a .json export file.');
  };

  return (
    <>
      {/* ── Trigger ── */}
      <button
        id="export-import-btn"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-700/60 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700/80 hover:text-white transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Export / Import
      </button>

      {/* ── Dialog Modal ── */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else setOpen(true); }}>
        <DialogContent
          showCloseButton={false}
          className="w-full max-w-[480px] p-0 bg-slate-950 border border-slate-800/85 flex flex-col overflow-hidden gap-0 rounded-2xl shadow-2xl text-slate-200"
        >
          {/* Header */}
          <DialogHeader className="flex-row items-center justify-between px-6 pt-6 pb-5 gap-0 border-b border-slate-900/80 bg-slate-950 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div>
                <DialogTitle className="text-sm font-semibold text-white leading-tight !text-sm">Export / Import</DialogTitle>
                <DialogDescription className="text-[11px] text-slate-500 mt-0.5 !text-[11px]">Backup and restore accounts</DialogDescription>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-900 hover:text-slate-350 transition-colors flex-shrink-0 mr-0"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </DialogHeader>

          {/* Tab Switch */}
          <div className="mx-6 mb-4 mt-4 flex-shrink-0">
            <div className="flex p-1 bg-slate-900 rounded-xl border border-slate-800/60">
              {(['export', 'import'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all duration-200 ${tab === t ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/40' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {t === 'export' ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" />
                    </svg>
                  )}
                  {t === 'export' ? 'Export' : 'Import'}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 space-y-5 pb-4 min-h-0 max-h-[50vh] bg-slate-950/40">

            {/* ── EXPORT TAB ── */}
            {tab === 'export' && (
              <>
                {/* Account selector */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Select Accounts</span>
                    {!accountsLoading && accounts.length > 0 && (
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-slate-500">{selectedIds.size} / {accounts.length}</span>
                        <button
                          onClick={() => allSelected ? setSelectedIds(new Set()) : setSelectedIds(new Set(accounts.map(a => a.id)))}
                          className="text-[11px] font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          {allSelected ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 overflow-hidden">
                    {accountsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-slate-500 text-xs"><Spinner /> Loading…</div>
                    ) : accounts.length === 0 ? (
                      <div className="py-8 text-center text-slate-600 text-xs">No accounts found</div>
                    ) : (
                      <div className="divide-y divide-slate-800/60 max-h-44 overflow-y-auto">
                        {accounts.map((acct) => {
                          const checked = selectedIds.has(acct.id);
                          return (
                            <button
                              key={acct.id}
                              onClick={() => toggleAccount(acct.id)}
                              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150 ${checked ? 'bg-indigo-950/40 hover:bg-indigo-950/60' : 'hover:bg-slate-800/40'}`}
                            >
                              <div className={`h-4 w-4 rounded flex-shrink-0 border flex items-center justify-center transition-all ${checked ? 'bg-indigo-600 border-indigo-500' : 'border-slate-600'}`}>
                                {checked && <svg className="h-2.5 w-2.5 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" /></svg>}
                              </div>
                              <Avatar email={acct.email} selected={checked} />
                              <div className="min-w-0 flex-1">
                                <p className={`text-xs font-medium truncate ${checked ? 'text-slate-100' : 'text-slate-400'}`}>{acct.nickname ?? acct.email}</p>
                                {acct.nickname && <p className="text-[10px] text-slate-650 truncate">{acct.email}</p>}
                              </div>
                              {acct.tier && <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded flex-shrink-0">{acct.tier}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {noneSelected && !accountsLoading && accounts.length > 0 && (
                    <p className="text-[11px] text-amber-500/90 flex items-center gap-1.5">
                      <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                      Select at least one account
                    </p>
                  )}
                </div>

                {/* Security notice */}
                <div className="flex gap-3 rounded-xl border border-amber-900/40 bg-amber-950/20 p-4">
                  <div className="mt-0.5 flex-shrink-0 text-amber-500"><svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg></div>
                  <div>
                    <p className="text-[11px] font-semibold text-amber-400">Sensitive export</p>
                    <p className="text-[11px] text-amber-200/60 leading-relaxed mt-0.5">Contains raw OAuth refresh tokens encrypted with AES-256-GCM. Keep this file private.</p>
                  </div>
                </div>

                {/* Passphrase fields */}
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label htmlFor="export-passphrase" className="block text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Passphrase</label>
                    <div className="relative">
                      <input
                        id="export-passphrase"
                        type={showExportPass ? 'text' : 'password'}
                        value={exportPass}
                        onChange={(e) => { setExportPass(e.target.value); if (exportPassErr) setExportPassErr(''); }}
                        placeholder="Minimum 4 characters"
                        className={`w-full rounded-xl border bg-slate-900 px-4 py-2.5 pr-10 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 transition-all ${exportPassErr ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/30' : 'border-slate-800 focus:border-indigo-500/60 focus:ring-indigo-500/20'}`}
                      />
                      <button type="button" onClick={() => setShowExportPass(!showExportPass)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-600 hover:text-slate-400 transition-colors"><EyeIcon show={showExportPass} /></button>
                    </div>
                    {exportPassErr && <p className="text-[11px] text-red-400">{exportPassErr}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="export-passphrase-confirm" className="block text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Confirm Passphrase</label>
                    <div className="relative">
                      <input
                        id="export-passphrase-confirm"
                        type={showExportConfirm ? 'text' : 'password'}
                        value={exportConfirm}
                        onChange={(e) => { setExportConfirm(e.target.value); if (exportConfirmErr) setExportConfirmErr(''); }}
                        placeholder="Re-enter passphrase"
                        className={`w-full rounded-xl border bg-slate-900 px-4 py-2.5 pr-10 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 transition-all ${exportConfirmErr ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/30' : 'border-slate-800 focus:border-indigo-500/60 focus:ring-indigo-500/20'}`}
                      />
                      <button type="button" onClick={() => setShowExportConfirm(!showExportConfirm)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-600 hover:text-slate-400 transition-colors"><EyeIcon show={showExportConfirm} /></button>
                    </div>
                    {exportConfirmErr && <p className="text-[11px] text-red-400">{exportConfirmErr}</p>}
                  </div>
                </div>
              </>
            )}

            {/* ── IMPORT TAB ── */}
            {tab === 'import' && (
              <>
                <div className="flex gap-3 rounded-xl border border-indigo-900/40 bg-indigo-950/20 p-4">
                  <div className="mt-0.5 flex-shrink-0 text-indigo-400"><svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg></div>
                  <div>
                    <p className="text-[11px] font-semibold text-indigo-300">How import works</p>
                    <ul className="text-[11px] text-indigo-200/50 mt-0.5 space-y-0.5">
                      <li>· Existing accounts (by email) are skipped — no overwrites</li>
                      <li>· Quota fetched automatically for new accounts</li>
                      <li>· Page reloads on success</li>
                    </ul>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Export file</label>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-all duration-200 ${dragOver ? 'border-indigo-500/70 bg-indigo-950/30' : importFile ? 'border-emerald-600/50 bg-emerald-950/20' : 'border-slate-700/60 bg-slate-900/40 hover:border-slate-600/80'}`}
                  >
                    {importFile ? (
                      <>
                        <div className="h-10 w-10 rounded-xl bg-emerald-900/40 border border-emerald-700/40 flex items-center justify-center">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        </div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-emerald-300 truncate max-w-[260px]">{importFile.name}</p>
                          <p className="text-[11px] text-slate-500 mt-0.5">{(importFile.size / 1024).toFixed(1)} KB</p>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setImportFile(null); }} className="text-[11px] text-slate-500 hover:text-red-400 transition-colors">× Remove</button>
                      </>
                    ) : (
                      <>
                        <div className="h-10 w-10 rounded-xl bg-slate-800 border border-slate-700/60 flex items-center justify-center">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                        </div>
                        <div className="text-center">
                          <p className="text-xs font-medium text-slate-300">Drop file here or click to browse</p>
                          <p className="text-[11px] text-slate-600 mt-0.5">.json export files only</p>
                        </div>
                      </>
                    )}
                  </div>
                  <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0] ?? null; setImportFile(f); e.target.value = ''; }} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="import-passphrase" className="block text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Passphrase</label>
                  <div className="relative">
                    <input
                      id="import-passphrase"
                      type={showImportPass ? 'text' : 'password'}
                      value={importPass}
                      onChange={(e) => setImportPass(e.target.value)}
                      placeholder="Enter the passphrase from export"
                      className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-2.5 pr-10 text-sm text-white placeholder-slate-600 focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/20 transition-all"
                    />
                    <button type="button" onClick={() => setShowImportPass(!showImportPass)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-600 hover:text-slate-400 transition-colors"><EyeIcon show={showImportPass} /></button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-slate-900/80 bg-slate-950 flex-shrink-0 flex items-center justify-end gap-3">
            {tab === 'export' ? (
              <>
                <button onClick={handleClose} className="rounded-xl border border-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors">Cancel</button>
                <button
                  id="export-accounts-btn"
                  onClick={() => void handleExport()}
                  disabled={exportLoading || noneSelected || accountsLoading}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-35 disabled:cursor-not-allowed py-2.5 text-xs font-semibold text-white transition-all shadow-lg shadow-indigo-900/40"
                >
                  {exportLoading ? <><Spinner /> Exporting…</> : <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    Export {selectedIds.size > 0 ? `${selectedIds.size} ` : ''}Account{selectedIds.size !== 1 ? 's' : ''}
                  </>}
                </button>
              </>
            ) : (
              <>
                <button onClick={handleClose} className="rounded-xl border border-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors">Cancel</button>
                <button
                  id="import-accounts-btn"
                  onClick={() => void handleImport()}
                  disabled={importLoading || !importFile || !importPass.trim()}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-35 disabled:cursor-not-allowed py-2.5 text-xs font-semibold text-white transition-all shadow-lg shadow-indigo-900/40"
                >
                  {importLoading ? <><Spinner /> Importing…</> : <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l4-4m0 0l4 4m-4-4v12" /></svg>
                    Import Accounts
                  </>}
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-[10000] flex items-center gap-2.5 rounded-xl border px-4 py-3 text-xs font-semibold shadow-2xl ${toast.type === 'success' ? 'border-emerald-700/50 bg-emerald-950/95 text-emerald-300' : 'border-red-700/50 bg-red-950/95 text-red-300'}`}
          style={{ animation: 'eiSlideUp 0.25s cubic-bezier(0.16,1,0.3,1)' }}
        >
          {toast.type === 'success'
            ? <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
            : <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
          }
          {toast.msg}
        </div>
      )}
      <style>{`@keyframes eiSlideUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </>
  );
}
