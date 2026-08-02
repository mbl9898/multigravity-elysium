// src/lib/cloudcode/collapse.ts
// Shared message-collapsing utilities.
// Converts OpenAI and Anthropic message arrays into the normalised
// CloudCodeMessage[] format expected by buildGeminiPayload / buildClaudePayload.

import type { CloudCodeMessage } from './client';

// ─── OpenAI format ────────────────────────────────────────────────────────────

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >
    | null
    | undefined;
}

/**
 * Collapses an OpenAI messages array into CloudCodeMessage[].
 * System messages are prepended to the first user turn as a prefix block so
 * they are always visible to the model regardless of whether it uses
 * systemInstruction natively.
 */
export function collapseOpenAIMessages(messages: OpenAIMessage[]): CloudCodeMessage[] {
  const out: CloudCodeMessage[] = [];
  let systemBlock = '';

  for (const msg of messages) {
    let text = '';
    const images: Array<{ mimeType: string; data: string }> = [];

    if (typeof msg.content === 'string') {
      text = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          text += (text ? '\n' : '') + part.text;
        } else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
          const url = part.image_url.url;
          const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(url);
          if (match && match[1] && match[2]) {
            images.push({ mimeType: match[1], data: match[2] });
          }
        }
      }
    }

    if (!text && images.length === 0) continue;

    if (msg.role === 'system') {
      systemBlock += (systemBlock ? '\n\n' : '') + text;
    } else if (msg.role === 'user') {
      const content = systemBlock ? `[system]\n${systemBlock}\n\n[user]\n${text}` : text;
      systemBlock = ''; // consumed
      out.push({
        role: 'user',
        content,
        ...(images.length > 0 ? { images } : {}),
      });
    } else {
      // assistant
      out.push({
        role: 'assistant',
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
    }
  }

  // Edge case: trailing system block with no following user turn
  if (systemBlock) {
    out.push({ role: 'user', content: `[system]\n${systemBlock}` });
  }

  return out;
}

// ─── Anthropic format ─────────────────────────────────────────────────────────

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: string; [k: string]: unknown }>;
}

/**
 * Collapses an Anthropic messages array + optional top-level `system` string
 * into CloudCodeMessage[].
 *
 * The `system` field is prepended as a prefix on the first user message so it
 * flows through the same CloudCode request path without requiring special handling
 * in every caller. The caller may also pass it separately via buildClaudePayload's
 * systemInstruction option.
 *
 * Returns { messages, systemPrompt } so callers can choose how to inject the
 * system prompt (as a prefix in messages OR via systemInstruction in the payload).
 */
export function collapseAnthropicMessages(
  messages: AnthropicMessage[],
  system?: string,
): { messages: CloudCodeMessage[]; systemPrompt: string } {
  const out: CloudCodeMessage[] = [];

  for (const msg of messages) {
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n')
        .trim();
    }
    if (!text) continue;
    out.push({ role: msg.role, content: text });
  }

  return { messages: out, systemPrompt: system ?? '' };
}
