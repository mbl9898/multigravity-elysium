'use client';
// src/app/chat/page.tsx — AI Chat using Gemini & Claude via cloudcode-pa.googleapis.com

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Account } from '@/types';

/* ---------- Types ---------- */
interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  ts: Date;
  modelLabel?: string;
  provider?: string;
  error?: boolean;
}
interface AccountsResponse { accounts: Account[]; }

/* ---------- Model Catalogue ---------- */
const MODEL_GROUPS = [
  {
    group: 'Gemini',
    color: 'from-blue-500 to-indigo-600',
    dot: 'bg-blue-400',
    models: [
      { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)', sub: 'Fast' },
      { id: 'gemini-3.5-flash-high',   label: 'Gemini 3.5 Flash (High)',   sub: 'Fast' },
      { id: 'gemini-3.5-flash-low',    label: 'Gemini 3.5 Flash (Low)',    sub: 'Fast' },
      { id: 'gemini-3.1-pro-low',      label: 'Gemini 3.1 Pro (Low)',      sub: 'Capable' },
      { id: 'gemini-3.1-pro-high',     label: 'Gemini 3.1 Pro (High)',     sub: 'Capable' },
    ],
  },
  {
    group: 'Claude & GPT',
    color: 'from-orange-500 to-rose-600',
    dot: 'bg-orange-400',
    models: [
      { id: 'claude-sonnet-4-6',           label: 'Claude Sonnet 4.6 (Thinking)', sub: 'Thinking' },
      { id: 'claude-opus-4-6',             label: 'Claude Opus 4.6 (Thinking)',   sub: 'Thinking' },
      { id: 'gpt-oss-120b-medium',         label: 'GPT-OSS 120B (Medium)',        sub: 'Open Source' },
    ],
  },
] as const;

function findModel(id: string) {
  for (const g of MODEL_GROUPS) {
    for (const m of g.models) {
      if (m.id === id) return { ...m, group: g.group, color: g.color };
    }
  }
  return null;
}

/* ---------- Simple Markdown renderer ---------- */
function RenderMarkdown({ text }: { text: string }) {
  // Convert fenced code blocks, bold, inline code, lists
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let key = 0;

  function flush() {
    if (codeLines.length) {
      result.push(
        <pre key={key++} className="my-3 rounded-xl bg-slate-900/80 border border-slate-700/50 p-4 overflow-x-auto">
          {codeLang && <div className="text-[10px] text-slate-500 mb-2 font-mono uppercase tracking-widest">{codeLang}</div>}
          <code className="text-sm text-emerald-300 font-mono leading-relaxed">{codeLines.join('\n')}</code>
        </pre>
      );
      codeLines = [];
      codeLang = '';
    }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCode) { inCode = true; codeLang = line.slice(3).trim(); }
      else { inCode = false; flush(); }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h1) { result.push(<h1 key={key++} className="text-xl font-bold text-slate-100 mt-4 mb-2">{h1[1]}</h1>); continue; }
    if (h2) { result.push(<h2 key={key++} className="text-lg font-semibold text-slate-100 mt-3 mb-1.5">{h2[1]}</h2>); continue; }
    if (h3) { result.push(<h3 key={key++} className="text-base font-semibold text-slate-200 mt-2 mb-1">{h3[1]}</h3>); continue; }

    // Bullet list
    const bullet = line.match(/^[-*] (.+)/);
    if (bullet) {
      result.push(
        <div key={key++} className="flex gap-2 leading-relaxed my-0.5">
          <span className="text-indigo-400 mt-1.5 shrink-0">▸</span>
          <span>{inlineFormat(bullet[1])}</span>
        </div>
      );
      continue;
    }

    // Numbered list
    const num = line.match(/^(\d+)\. (.+)/);
    if (num) {
      result.push(
        <div key={key++} className="flex gap-2 leading-relaxed my-0.5">
          <span className="text-indigo-400 shrink-0 font-mono text-sm">{num[1]}.</span>
          <span>{inlineFormat(num[2])}</span>
        </div>
      );
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*]{3,}$/)) {
      result.push(<hr key={key++} className="my-3 border-slate-700/50" />);
      continue;
    }

    // Empty line
    if (!line.trim()) { result.push(<div key={key++} className="h-2" />); continue; }

    // Normal paragraph
    result.push(<p key={key++} className="leading-relaxed my-0.5">{inlineFormat(line)}</p>);
  }

  if (inCode) flush();
  return <div className="text-sm text-slate-200 space-y-0.5">{result}</div>;
}

function inlineFormat(text: string): React.ReactNode {
  // Bold **x**, inline code `x`, italic *x*
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i} className="text-slate-100 font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className="bg-slate-700/60 text-purple-300 rounded px-1 py-0.5 font-mono text-[0.8em]">{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i} className="text-slate-300 italic">{part.slice(1, -1)}</em>;
    return part;
  });
}

/* ---------- Icons ---------- */
const GeminiIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-full w-full">
    <path d="M12 2L13.5 9.5H21L15 14L17.5 22L12 17.5L6.5 22L9 14L3 9.5H10.5L12 2Z" fill="currentColor" />
  </svg>
);

const ClaudeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-full w-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
  </svg>
);

const UserIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-full w-full">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
  </svg>
);

/* ---------- Main Component ---------- */
export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3-flash');
  const [isLoading, setIsLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<AccountsResponse>({
    queryKey: ['accounts'],
    queryFn: async () => {
      const r = await fetch('/api/accounts');
      if (!r.ok) throw new Error('failed');
      return r.json() as Promise<AccountsResponse>;
    },
  });

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);

  useEffect(() => {
    if (accounts.length && !selectedAccountId) setSelectedAccountId(accounts[0].id);
  }, [accounts, selectedAccountId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [input]);

  // Close model menu on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const activeModel = findModel(selectedModel);
  const isGemini = activeModel?.group === 'Gemini';

  const send = useCallback(async () => {
    if (!input.trim() || !selectedAccountId || isLoading) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: input.trim(), ts: new Date() };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setIsLoading(true);

    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, messages: apiMessages, model: selectedModel }),
      });
      const d = await res.json() as { text?: string; modelLabel?: string; provider?: string; error?: string };

      setMessages((prev) => [
        ...prev,
        {
          id: `m-${Date.now()}`,
          role: 'model',
          content: d.error ? `Error: ${d.error}` : (d.text ?? ''),
          ts: new Date(),
          modelLabel: d.modelLabel,
          provider: d.provider,
          error: !!d.error,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: `e-${Date.now()}`, role: 'model', content: `Network error: ${String(err)}`,
        ts: new Date(), error: true,
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [input, selectedAccountId, isLoading, messages, selectedModel]);

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  }

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  return (
    <div className="flex flex-col h-screen bg-slate-950" style={{ fontFamily: 'inherit' }}>

      {/* ── Top bar ── */}
      <header className="shrink-0 border-b border-slate-800/60 bg-slate-900/90 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-4">

          {/* Back */}
          <Link href="/" className="text-slate-500 hover:text-slate-200 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </Link>

          {/* Title */}
          <div className="flex items-center gap-2 mr-auto">
            <div className={`h-7 w-7 rounded-lg bg-gradient-to-br ${isGemini ? 'from-blue-500 to-indigo-600' : 'from-orange-500 to-rose-600'} flex items-center justify-center p-1.5 transition-all duration-300`}>
              {isGemini ? <GeminiIcon /> : <ClaudeIcon />}
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-100 leading-none">AI Chat</div>
              <div className="text-[10px] text-slate-500 leading-none mt-0.5">via Antigravity</div>
            </div>
          </div>

          {/* Account selector */}
          {accounts.length > 1 && (
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="text-xs bg-slate-800/80 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 max-w-[160px]"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.nickname ?? a.email}</option>
              ))}
            </select>
          )}

          {/* Model picker */}
          <div className="relative" ref={modelMenuRef}>
            <button
              onClick={() => setModelMenuOpen((o) => !o)}
              className="flex items-center gap-2 text-xs bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 rounded-lg px-3 py-1.5 text-slate-300 hover:text-slate-100 transition-all"
            >
              <span className={`h-2 w-2 rounded-full ${isGemini ? 'bg-blue-400' : 'bg-orange-400'} shrink-0`} />
              <span className="font-medium">{activeModel?.label ?? selectedModel}</span>
              <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {modelMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-64 bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl shadow-black/40 z-50 overflow-hidden">
                {MODEL_GROUPS.map((group) => (
                  <div key={group.group}>
                    <div className={`px-3 py-2 text-[10px] font-bold uppercase tracking-widest bg-gradient-to-r ${group.color} bg-clip-text text-transparent border-b border-slate-800/60`}>
                      {group.group}
                    </div>
                    {group.models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => { setSelectedModel(m.id); setModelMenuOpen(false); }}
                        className={`w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-slate-800/60 transition-colors ${selectedModel === m.id ? 'bg-slate-800/60' : ''}`}
                      >
                        <div>
                          <div className="text-sm text-slate-200 font-medium">{m.label}</div>
                          <div className="text-[11px] text-slate-500">{m.sub}</div>
                        </div>
                        {selectedModel === m.id && (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">

          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center space-y-5">
              <div className="relative">
                <div className={`h-20 w-20 rounded-2xl bg-gradient-to-br ${isGemini ? 'from-blue-500/20 to-indigo-600/20 border-blue-500/20' : 'from-orange-500/20 to-rose-600/20 border-orange-500/20'} border flex items-center justify-center p-4 transition-all duration-300`}>
                  <div className={`text-${isGemini ? 'blue' : 'orange'}-400 h-full w-full`}>
                    {isGemini ? <GeminiIcon /> : <ClaudeIcon />}
                  </div>
                </div>
                <div className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-emerald-500 border-2 border-slate-950 animate-pulse" />
              </div>

              <div>
                <div className="text-xl font-bold text-slate-100">Your AI is ready</div>
                <div className="text-sm text-slate-500 mt-1">
                  {activeModel?.label} · {selectedAccount?.email ?? '…'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 w-full max-w-lg mt-2">
                {[
                  'Explain how Antigravity manages quota limits',
                  'Write a Python script to call Gemini via API',
                  'What\'s the difference between Claude Sonnet and Opus?',
                  'How does the cloudcode-pa.googleapis.com endpoint work?',
                ].map((p) => (
                  <button
                    key={p}
                    onClick={() => setInput(p)}
                    className="text-left text-xs text-slate-400 hover:text-slate-200 bg-slate-800/40 hover:bg-slate-800/80 border border-slate-700/30 hover:border-slate-600/60 rounded-xl px-3.5 py-3 transition-all leading-relaxed"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>

              {/* Avatar */}
              <div className={`shrink-0 h-8 w-8 rounded-xl flex items-center justify-center p-1.5 ${
                msg.role === 'user'
                  ? 'bg-slate-700/60 border border-slate-600/40'
                  : msg.error
                  ? 'bg-red-900/30 border border-red-800/30'
                  : isGemini
                  ? 'bg-gradient-to-br from-blue-500/20 to-indigo-600/20 border border-blue-500/20'
                  : 'bg-gradient-to-br from-orange-500/20 to-rose-600/20 border border-orange-500/20'
              }`}>
                <div className={`h-full w-full ${
                  msg.role === 'user' ? 'text-slate-400' :
                  msg.error ? 'text-red-400' :
                  isGemini ? 'text-blue-400' : 'text-orange-400'
                }`}>
                  {msg.role === 'user' ? <UserIcon /> : isGemini ? <GeminiIcon /> : <ClaudeIcon />}
                </div>
              </div>

              {/* Bubble */}
              <div className={`max-w-[82%] flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`rounded-2xl px-4 py-3 ${
                  msg.role === 'user'
                    ? 'bg-indigo-600/20 border border-indigo-500/20 rounded-tr-sm'
                    : msg.error
                    ? 'bg-red-950/40 border border-red-800/30 rounded-tl-sm'
                    : 'bg-slate-800/50 border border-slate-700/40 rounded-tl-sm'
                }`}>
                  {msg.role === 'user'
                    ? <p className="text-sm text-slate-100 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                    : <RenderMarkdown text={msg.content} />
                  }
                </div>
                <div className="flex items-center gap-2 px-1">
                  <span className="text-[10px] text-slate-600">
                    {msg.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {msg.modelLabel && (
                    <span className="text-[10px] text-slate-700">· {msg.modelLabel}</span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isLoading && (
            <div className="flex gap-3">
              <div className={`shrink-0 h-8 w-8 rounded-xl flex items-center justify-center p-1.5 bg-gradient-to-br ${isGemini ? 'from-blue-500/20 to-indigo-600/20 border-blue-500/20' : 'from-orange-500/20 to-rose-600/20 border-orange-500/20'} border`}>
                <div className={`h-full w-full animate-pulse ${isGemini ? 'text-blue-400' : 'text-orange-400'}`}>
                  {isGemini ? <GeminiIcon /> : <ClaudeIcon />}
                </div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/40 rounded-2xl rounded-tl-sm px-4 py-3.5">
                <div className="flex gap-1.5 items-center h-4">
                  {[0, 150, 300].map((d) => (
                    <div key={d} className={`h-1.5 w-1.5 rounded-full ${isGemini ? 'bg-blue-400/60' : 'bg-orange-400/60'} animate-bounce`} style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input ── */}
      <div className="shrink-0 border-t border-slate-800/60 bg-slate-900/80 backdrop-blur-md p-4">
        <div className="max-w-3xl mx-auto">
          {accounts.length === 0 ? (
            <div className="text-center py-3 text-sm text-slate-500">
              <a href="/api/auth/login" className="text-indigo-400 hover:underline">Add an account</a> to start chatting
            </div>
          ) : (
            <div className={`flex items-end gap-3 bg-slate-800/50 border rounded-2xl px-4 py-3 transition-all shadow-lg focus-within:ring-1 ${
              isGemini
                ? 'border-slate-700/50 focus-within:border-blue-500/40 focus-within:ring-blue-500/10'
                : 'border-slate-700/50 focus-within:border-orange-500/40 focus-within:ring-orange-500/10'
            }`}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder={`Message ${activeModel?.label ?? 'AI'}… (Enter to send)`}
                rows={1}
                disabled={isLoading}
                className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 resize-none focus:outline-none min-h-6 leading-relaxed"
              />
              <button
                onClick={() => void send()}
                id="send-message-btn"
                disabled={!input.trim() || !selectedAccountId || isLoading}
                className={`shrink-0 h-8 w-8 rounded-xl flex items-center justify-center transition-all shadow-sm ${
                  isGemini
                    ? 'bg-blue-600 hover:bg-blue-500 shadow-blue-900/20 disabled:bg-slate-700'
                    : 'bg-orange-600 hover:bg-orange-500 shadow-orange-900/20 disabled:bg-slate-700'
                } disabled:opacity-40 disabled:shadow-none`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
            </div>
          )}
          <p className="text-center text-[10px] text-slate-700 mt-2 font-mono">
            cloudcode-pa.googleapis.com/v1internal · your Antigravity quota
          </p>
        </div>
      </div>
    </div>
  );
}
