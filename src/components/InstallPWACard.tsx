// src/components/InstallPWACard.tsx
// In-app PWA install banner/card.
//
// Behaviour by platform:
//   • Chrome/Edge on desktop/Android — listens for `beforeinstallprompt`;
//     shows a "Install App" button that triggers the native prompt.
//   • Safari on macOS/iOS — shows manual "Share → Add to Dock/Home Screen" instructions.
//   • Already running in standalone mode (installed) — renders nothing.
//   • User dismissed the card — hidden for the session (localStorage key).
'use client';

import { useEffect, useState } from 'react';

// Extend the Window type for the non-standard beforeinstallprompt event
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallState =
  | 'checking'      // SSR / initial mount
  | 'installed'     // already running as standalone PWA
  | 'promptable'    // Chrome/Edge: native install prompt available
  | 'safari-macos'  // Safari on macOS
  | 'safari-ios'    // Safari on iOS
  | 'unsupported';  // browser doesn't support PWA install at all

const DISMISSED_KEY = 'pwa-install-dismissed';

export function InstallPWACard() {
  const [state, setState] = useState<InstallState>('checking');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Already dismissed this session
    if (localStorage.getItem(DISMISSED_KEY)) {
      setDismissed(true);
      return;
    }

    // Already running as installed PWA
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setState('installed');
      return;
    }

    const ua = navigator.userAgent;
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
    const isIOS = /iphone|ipad|ipod/i.test(ua);

    if (isIOS && isSafari) {
      setState('safari-ios');
      return;
    }

    if (isSafari) {
      // macOS Safari
      setState('safari-macos');
      return;
    }

    // Chrome / Edge / other Chromium — wait for the prompt event
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setState('promptable');
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Give it 1.5 s; if no prompt fires the browser doesn't support it
    const timeout = setTimeout(() => {
      setState((prev) => (prev === 'checking' ? 'unsupported' : prev));
    }, 1500);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      clearTimeout(timeout);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setInstalling(false);
    if (outcome === 'accepted') {
      setState('installed');
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  // Don't render anything if installed, unsupported, checking, or dismissed
  if (dismissed || state === 'installed' || state === 'unsupported' || state === 'checking') {
    return null;
  }

  // ── Promptable (Chrome / Edge) ─────────────────────────────────────────────
  if (state === 'promptable') {
    return (
      <div
        id="pwa-install-card"
        role="banner"
        className="relative flex items-center gap-4 rounded-xl border border-indigo-500/25 bg-indigo-950/30 px-4 py-3.5 backdrop-blur-sm"
        style={{ boxShadow: '0 0 0 1px rgba(99,102,241,0.08) inset' }}
      >
        {/* Icon */}
        <div className="flex-shrink-0 h-9 w-9 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4.5 w-4.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
          </svg>
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-100 leading-snug">Install as App</p>
          <p className="text-xs text-slate-400 mt-0.5 leading-snug">
            Add to your dock for instant access — no browser needed.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            id="pwa-install-btn"
            onClick={() => void handleInstall()}
            disabled={installing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold px-3 py-1.5 transition-colors shadow-md shadow-indigo-900/30"
          >
            {installing ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Installing…
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Install App
              </>
            )}
          </button>
          <button
            id="pwa-install-dismiss"
            onClick={handleDismiss}
            aria-label="Dismiss install prompt"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ── Safari on macOS ────────────────────────────────────────────────────────
  if (state === 'safari-macos') {
    return (
      <div
        id="pwa-install-card-safari"
        role="banner"
        className="relative flex items-start gap-4 rounded-xl border border-indigo-500/25 bg-indigo-950/30 px-4 py-3.5 backdrop-blur-sm"
        style={{ boxShadow: '0 0 0 1px rgba(99,102,241,0.08) inset' }}
      >
        {/* Icon */}
        <div className="flex-shrink-0 h-9 w-9 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mt-0.5">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4.5 w-4.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-100 leading-snug">Add to Dock</p>
          <p className="text-xs text-slate-400 mt-0.5 leading-snug">
            In Safari, click{' '}
            <span className="inline-flex items-center gap-0.5 font-medium text-slate-300">
              <ShareIcon />
              {' '}Share
            </span>
            {' '}→{' '}
            <span className="font-medium text-slate-300">Add to Dock</span>
            {' '}for a standalone app icon.
          </p>
        </div>

        {/* Dismiss */}
        <button
          id="pwa-safari-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="flex-shrink-0 p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  // ── Safari on iOS ──────────────────────────────────────────────────────────
  if (state === 'safari-ios') {
    return (
      <div
        id="pwa-install-card-ios"
        role="banner"
        className="relative flex items-start gap-4 rounded-xl border border-indigo-500/25 bg-indigo-950/30 px-4 py-3.5 backdrop-blur-sm"
        style={{ boxShadow: '0 0 0 1px rgba(99,102,241,0.08) inset' }}
      >
        <div className="flex-shrink-0 h-9 w-9 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center mt-0.5">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4.5 w-4.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-100 leading-snug">Add to Home Screen</p>
          <p className="text-xs text-slate-400 mt-0.5 leading-snug">
            Tap{' '}
            <span className="inline-flex items-center gap-0.5 font-medium text-slate-300">
              <ShareIcon />
              {' '}Share
            </span>
            {' '}→{' '}
            <span className="font-medium text-slate-300">Add to Home Screen</span>
            {' '}to launch as an app.
          </p>
        </div>
        <button
          id="pwa-ios-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="flex-shrink-0 p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return null;
}

// ── Mini Share icon (matches Safari's actual Share glyph) ─────────────────
function ShareIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      className="inline h-3.5 w-3.5 align-middle"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
    </svg>
  );
}
