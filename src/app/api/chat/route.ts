// src/app/api/chat/route.ts
// POST /api/chat — Proxy chat to Gemini OR Claude via cloudcode-pa.googleapis.com
//
// ENDPOINT: https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse
// - Gemini: { model, request: { model, contents, generationConfig } }  → SSE response
// - Claude: Same endpoint wraps Anthropic's format inside the same request structure
//
// KEY RULES (from open-source proxy analysis):
//   1. NO x-goog-user-project header
//   2. Wrap payload in { model, request: { ... } }
//   3. Claude uses "role: assistant" (not "model"), and system prompt goes in systemInstruction

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/database/client';
import { decrypt } from '@/lib/encryption';
import { refreshAccessToken } from '@/lib/antigravity/auth';

const CLOUDCODE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];

// All supported models
export const MODELS = {
  // Gemini models
  'gemini-3-flash': { label: 'Gemini 3 Flash', provider: 'gemini', description: 'Fast & efficient' },
  'gemini-3-pro':   { label: 'Gemini 3 Pro',   provider: 'gemini', description: 'Most capable Gemini' },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', provider: 'gemini', description: 'Previous gen fast' },
  'gemini-2.5-pro':   { label: 'Gemini 2.5 Pro',   provider: 'gemini', description: 'Previous gen pro' },
  // Claude / Anthropic models (via cloudcode proxy)
  'claude-sonnet-4-5':         { label: 'Claude Sonnet 4.5', provider: 'claude', description: 'Balanced & smart' },
  'claude-opus-4-5':           { label: 'Claude Opus 4.5',   provider: 'claude', description: 'Most capable Claude' },
  'claude-sonnet-4-5-thinking':{ label: 'Claude Sonnet 4.5 Thinking', provider: 'claude', description: 'Extended reasoning' },
  'claude-opus-4-5-thinking':  { label: 'Claude Opus 4.5 Thinking',   provider: 'claude', description: 'Best reasoning' },
  'claude-3-5-sonnet':         { label: 'Claude 3.5 Sonnet', provider: 'claude', description: 'Reliable classic' },
  'claude-3-5-haiku':          { label: 'Claude 3.5 Haiku',  provider: 'claude', description: 'Fast & cheap' },
} as const;

export type ModelId = keyof typeof MODELS;

export interface ChatMessage {
  role: 'user' | 'model' | 'assistant';
  content: string;
}

function buildGeminiRequest(modelId: string, messages: ChatMessage[]) {
  return {
    model: modelId,
    request: {
      model: modelId,
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 1.0,
      },
    },
  };
}

function buildClaudeRequest(modelId: string, messages: ChatMessage[]) {
  // Claude via cloudcode uses same wrapper but role is "user"/"assistant"
  return {
    model: modelId,
    request: {
      model: modelId,
      contents: messages.map((m) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 1.0,
      },
    },
  };
}

function extractTextFromSSE(rawText: string): string {
  let fullText = '';
  for (const line of rawText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const jsonStr = line.slice(6).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;
    try {
      const chunk = JSON.parse(jsonStr) as {
        response?: {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };
      };
      const text = chunk?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) fullText += text;
    } catch {
      // skip malformed lines
    }
  }
  return fullText;
}

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

    // Load raw account (needs encryptedRefreshToken)
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      return Response.json({ error: 'Account not found' }, { status: 404 });
    }

    // Decrypt and refresh token
    const refreshToken = decrypt(account.encryptedRefreshToken);
    const accessToken = await refreshAccessToken(refreshToken);

    // Build request body based on model provider
    const requestBody = JSON.stringify(
      modelInfo.provider === 'claude'
        ? buildClaudeRequest(model, messages)
        : buildGeminiRequest(model, messages)
    );

    // Headers — critically NO x-goog-user-project
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.11.5 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      'Client-Metadata': JSON.stringify({
        ideType: 'ANTIGRAVITY',
        platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS',
        pluginType: 'GEMINI',
      }),
    };

    let lastError = '';
    for (const baseUrl of CLOUDCODE_ENDPOINTS) {
      try {
        const upstream = await fetch(
          `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
          { method: 'POST', headers, body: requestBody }
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
