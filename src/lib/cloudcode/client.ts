// src/lib/cloudcode/client.ts
// Shared CloudCode helpers used by:
//   - /api/chat (legacy in-app chat)
//   - /api/v1/chat/completions (OpenAI-compatible gateway)
//   - /api/v1/messages (Anthropic-compatible gateway)
//
// KEY RULES (from open-source proxy analysis):
//   1. NO x-goog-user-project header
//   2. Wrap payload in { model, request: { ... } }
//   3. Claude uses "role: assistant" (not "model"), system prompt in systemInstruction
//   4. Gemini uses "role: model" for assistant turns

export const CLOUDCODE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

export const MODEL_POOL_MAP: Record<string, 'gemini' | 'anthropic'> = {
  'gemini-3-flash':              'gemini',
  'gemini-3.5-flash':            'gemini',
  'gemini-3-flash-agent':        'gemini',
  'gemini-2.5-flash-lite':       'gemini',
  'gemini-3.5-flash-medium':     'gemini',
  'gemini-3.5-flash-high':       'gemini',
  'gemini-3.5-flash-low':        'gemini',
  'gemini-3.1-pro-low':          'gemini',
  'gemini-3.1-pro-high':         'gemini',
  'claude-sonnet-4-6':           'anthropic',
  'claude-sonnet-4-6-thinking':  'anthropic',
  'claude-opus-4-6':             'anthropic',
  'claude-opus-4-6-thinking':    'anthropic',
  'gpt-oss-120b-medium':         'anthropic',
};

export interface CloudCodeMessage {
  role: 'user' | 'assistant' | 'model';
  content: string;
}

/** Standard request headers for cloudcode-pa.googleapis.com. No x-goog-user-project. */
export function buildRequestHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.11.5 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
      ideType: 'ANTIGRAVITY',
      platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS',
      pluginType: 'GEMINI',
    }),
  };
}

/** Build the CloudCode SSE request payload for Gemini models. */
export function buildGeminiPayload(modelId: string, messages: CloudCodeMessage[], options?: { maxOutputTokens?: number; temperature?: number }): object {
  return {
    model: modelId,
    request: {
      model: modelId,
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: options?.maxOutputTokens ?? 8192,
        temperature: options?.temperature ?? 1.0,
      },
    },
  };
}

/** Build the CloudCode SSE request payload for Claude/Anthropic models. */
export function buildClaudePayload(
  modelId: string,
  messages: CloudCodeMessage[],
  options?: { maxOutputTokens?: number; temperature?: number; systemPrompt?: string }
): object {
  const payload: Record<string, unknown> = {
    model: modelId,
    request: {
      model: modelId,
      contents: messages.map((m) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: options?.maxOutputTokens ?? 8192,
        temperature: options?.temperature ?? 1.0,
      },
    },
  };

  if (options?.systemPrompt) {
    (payload.request as Record<string, unknown>).systemInstruction = {
      parts: [{ text: options.systemPrompt }],
    };
  }

  return payload;
}

/**
 * Parse a single SSE line from Google's streamGenerateContent endpoint.
 *
 * Google SSE line format:
 *   data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}}
 *
 * Returns the extracted text delta, or null for non-content lines
 * (keepalives, [DONE], metadata-only chunks, etc.)
 */
export function parseGoogleSSELine(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const chunk = JSON.parse(payload) as {
      response?: {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
      };
    };
    const text = chunk?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Buffer and parse a full SSE response body into a single text string.
 * Used for non-streaming (stream:false) calls.
 */
export function extractTextFromSSE(rawText: string): string {
  let fullText = '';
  for (const line of rawText.split('\n')) {
    const delta = parseGoogleSSELine(line);
    if (delta) fullText += delta;
  }
  return fullText;
}
