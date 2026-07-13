// src/app/api/chat/route.ts
// POST /api/chat — Proxy chat to Gemini OR Claude via cloudcode-pa.googleapis.com
// Legacy endpoint used by the in-app chat UI (/chat page).
//
// For the load-balanced multi-account gateway endpoints, see:
//   /api/v1/chat/completions  (OpenAI-compatible)
//   /api/v1/messages          (Anthropic-compatible)

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';
import {
  CLOUDCODE_ENDPOINTS,
  buildRequestHeaders,
  buildGeminiPayload,
  buildClaudePayload,
  extractTextFromSSE,
} from '@/lib/cloudcode/client';

// ─── Model catalogue (re-exported for the chat UI) ───────────────────────────

export const MODELS = {
  'gemini-3-flash':              { label: 'Gemini 3 Flash',              provider: 'gemini', description: 'Fast' },
  'gemini-3.5-flash':            { label: 'Gemini 3.5 Flash',            provider: 'gemini', description: 'Fast' },
  'gemini-3.5-flash-medium':     { label: 'Gemini 3.5 Flash (Medium)',   provider: 'gemini', description: 'Fast' },
  'gemini-3.5-flash-high':       { label: 'Gemini 3.5 Flash (High)',     provider: 'gemini', description: 'Fast' },
  'gemini-3.5-flash-low':        { label: 'Gemini 3.5 Flash (Low)',      provider: 'gemini', description: 'Fast' },
  'gemini-3.1-pro-low':          { label: 'Gemini 3.1 Pro (Low)',        provider: 'gemini', description: 'Capabale' },
  'gemini-3.1-pro-high':         { label: 'Gemini 3.1 Pro (High)',       provider: 'gemini', description: 'Capable' },
  'claude-sonnet-4-6':           { label: 'Claude Sonnet 4.6 (Thinking)', provider: 'claude', description: 'Thinking' },
  'claude-opus-4-6':             { label: 'Claude Opus 4.6 (Thinking)',   provider: 'claude', description: 'Thinking' },
  'gpt-oss-120b-medium':         { label: 'GPT-OSS 120B (Medium)',        provider: 'claude', description: 'Open Source' },
} as const;

export type ModelId = keyof typeof MODELS;

export interface ChatMessage {
  role: 'user' | 'model' | 'assistant';
  content: string;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { accountId, messages, model = 'gemini-3-flash' } = body as {
      accountId: string;
      messages: ChatMessage[];
      model?: string;
    };

    if (!accountId || !messages?.length) {
      return Response.json({ error: 'accountId and messages are required' }, { status: 400 });
    }

    const modelInfo = MODELS[model as ModelId];
    if (!modelInfo) {
      return Response.json({ error: `Unknown model: ${model}` }, { status: 400 });
    }

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return Response.json({ error: 'Account not found' }, { status: 404 });
    }

    const refreshToken = decrypt(account.encryptedRefreshToken);
    const accessToken = await refreshAccessToken(refreshToken);

    const requestBody = JSON.stringify(
      modelInfo.provider === 'claude'
        ? buildClaudePayload(model, messages)
        : buildGeminiPayload(model, messages),
    );

    const headers = buildRequestHeaders(accessToken);

    let lastError = '';
    for (const baseUrl of CLOUDCODE_ENDPOINTS) {
      try {
        const upstream = await fetch(
          `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
          { method: 'POST', headers, body: requestBody },
        );

        if (!upstream.ok) {
          const errText = await upstream.text();
          lastError = `${baseUrl}: HTTP ${upstream.status} — ${errText.substring(0, 400)}`;
          continue;
        }

        const rawText = await upstream.text();
        const text = extractTextFromSSE(rawText);

        return Response.json({
          text,
          model,
          provider: modelInfo.provider,
          modelLabel: modelInfo.label,
          endpoint: baseUrl,
          account: account.email,
        });
      } catch (err) {
        lastError = String(err);
      }
    }

    return Response.json({ error: `All endpoints failed: ${lastError}` }, { status: 502 });
  } catch (err) {
    console.error('[/api/chat] Error:', err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
