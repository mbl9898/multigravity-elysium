// src/app/page.tsx — Main dashboard page
import { Dashboard } from '@/components/Dashboard';
import { Suspense } from 'react';

// Build version — bumps every server restart so you can confirm hot-reload picked up changes
const BUILD_VERSION = `v${new Date().toISOString().slice(0,10).replace(/-/g,'')}.${new Date().toISOString().slice(11,16).replace(':','')}`;

interface SearchParams {
  added?: string;
  error?: string;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      {/* ── Top bar ── */}
      <header className="border-b border-slate-800/60 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <span className="font-semibold text-slate-100 text-sm tracking-tight">
              Quota Dashboard
            </span>
            <span className="hidden sm:block text-slate-600 text-xs">Antigravity</span>
            <span
              title="Build version — click to select and copy"
              className="hidden sm:inline-flex items-center rounded-md bg-slate-800 border border-slate-700/60 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 select-all cursor-text hover:bg-slate-700/50 transition-colors"
            >
              {BUILD_VERSION}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/chat"
              id="open-chat-btn"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-slate-100 text-xs font-semibold px-3.5 py-2 transition-colors border border-slate-700/60"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L13.5 9.5H21L15 14L17.5 22L12 17.5L6.5 22L9 14L3 9.5H10.5L12 2Z" />
              </svg>
              Chat
            </a>
            <a
              href="/api/auth/login"
              id="add-account-btn"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-3.5 py-2 transition-colors shadow-md shadow-indigo-900/20"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Account
            </a>
          </div>
        </div>
      </header>

      {/* ── Toast notifications ── */}
      {params.added && (
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 pt-4">
          <div className="rounded-xl bg-emerald-950/50 border border-emerald-700/50 px-4 py-3 text-sm text-emerald-300 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Account added: <strong>{decodeURIComponent(params.added)}</strong>
          </div>
        </div>
      )}

      {params.error && (
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 pt-4">
          <div className="rounded-xl bg-red-950/50 border border-red-700/50 px-4 py-3 text-sm text-red-300 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {params.error === 'access_denied' && 'Access denied — login cancelled.'}
            {params.error === 'no_refresh_token' && 'No refresh token received. Try again.'}
            {params.error === 'invalid_state' && 'Invalid OAuth state. Please try again.'}
            {params.error === 'auth_failed' && 'Authentication failed. Please try again.'}
            {!['access_denied', 'no_refresh_token', 'invalid_state', 'auth_failed'].includes(params.error) &&
              `Login error: ${params.error}`}
          </div>
        </div>
      )}

      {/* ── Dashboard grid ── */}
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-6">
        <Suspense>
          <Dashboard />
        </Suspense>
      </div>
    </main>
  );
}
