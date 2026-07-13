// src/app/api/v1/chat/completions/route.ts
// POST /api/v1/chat/completions — OpenAI-compatible gateway endpoint.
//
// Accepts the standard OpenAI chat completions request shape.
// Transparently selects the best available Google account via the Elysium
// account router, forwards to cloudcode-pa.googleapis.com, and streams
// the response back in OpenAI SSE delta format.
//
// No auth — this endpoint is localhost-only. Security is enforced by the
// AI CLI Gateway's API key layer which sits in front of this daemon.

import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  CLOUDCODE_ENDPOINTS,
  MODEL_POOL_MAP,
  buildRequestHeaders,
  buildGeminiPayload,
  buildClaudePayload,
  parseGoogleSSELine,
  extractTextFromSSE,
} from '@/lib/cloudcode/client';
import { collapseOpenAIMessages } from '@/lib/cloudcode/collapse';
import {
  selectAndLockAccount,
  releaseAccount,
  markExhausted,
  AccountPoolExhaustedError,
  LockedAccountUnavailableError,
} from '@/lib/router/accountRouter';

// ─── Request schema ───────────────────────────────────────────────────────────

interface OpenAIRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResponse(message: string, status: number, code?: string): Response {
  return Response.json(
    { error: { message, type: 'api_error', code: code ?? 'error' } },
    { status },
  );
}

/** Try to get a successful upstream response, retrying through account pool on 429/403. */
async function openUpstream(
  model: string,
  pool: 'gemini' | 'anthropic',
  payloadStr: string,
  maxRetries: number,
): Promise<{ response: globalThis.Response; accountId: string; email: string }> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    const { accountId, email, accessToken } = await selectAndLockAccount(pool);
    const headers = buildRequestHeaders(accessToken);

    for (const baseUrl of CLOUDCODE_ENDPOINTS) {
      try {
        const upstream = await fetch(
          `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
          { method: 'POST', headers, body: payloadStr },
        );

        if (upstream.status === 429 || upstream.status === 403) {
          releaseAccount(accountId);
          await markExhausted(accountId, pool);
          attempt++;
          break; // try next account
        }

        if (!upstream.ok) {
          releaseAccount(accountId);
          throw new Error(`HTTP ${upstream.status} from ${baseUrl}`);
        }

        return { response: upstream, accountId, email };
      } catch (err) {
        if (err instanceof AccountPoolExhaustedError || err instanceof LockedAccountUnavailableError) {
          throw err;
        }
        // Network error on this endpoint — try next CloudCode endpoint
        if (CLOUDCODE_ENDPOINTS.indexOf(baseUrl as typeof CLOUDCODE_ENDPOINTS[number]) === CLOUDCODE_ENDPOINTS.length - 1) {
          releaseAccount(accountId);
          throw err;
        }
      }
    }
  }
  throw new AccountPoolExhaustedError(pool, 'retry_exhausted');
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  // Parse request
  let body: OpenAIRequest;
  try {
    body = (await req.json()) as OpenAIRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_request');
  }

  const { model, messages, stream = false, max_tokens, temperature } = body;

  if (!model || !messages?.length) {
    return errorResponse('model and messages are required', 400, 'invalid_request');
  }

  const pool = MODEL_POOL_MAP[model];
  if (!pool) {
    return errorResponse(
      `Unknown model: ${model}. Supported: ${Object.keys(MODEL_POOL_MAP).join(', ')}`,
      400,
      'invalid_model',
    );
  }

  console.log(`[ELYSIUM PROXY] /v1/chat/completions → model: ${model}, pool: ${pool}`);

  // Collapse messages
  const collapsed = collapseOpenAIMessages(messages);

  // Build payload
  const payloadObj =
    pool === 'anthropic'
      ? buildClaudePayload(model, collapsed, { maxOutputTokens: max_tokens, temperature })
      : buildGeminiPayload(model, collapsed, { maxOutputTokens: max_tokens, temperature });
  const payloadStr = JSON.stringify(payloadObj);

  // Count accounts for retry cap
  let maxRetries = 5; // conservative cap; router throws when pool truly empty
  try {
    const { prisma } = await import('@/lib/database/client');
    const count = await prisma.account.count({ where: { isHealthy: true } });
    maxRetries = Math.max(count, 1);
  } catch { /* use default */ }

  // ── Non-streaming ──────────────────────────────────────────────────────────
  if (!stream) {
    let accountId = '';
    try {
      const { response, accountId: aid, email } = await openUpstream(model, pool, payloadStr, maxRetries);
      accountId = aid;
      const rawText = await response.text();
      const text = extractTextFromSSE(rawText);
      releaseAccount(accountId);
      return Response.json({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        'x-elysium': { account: email, pool },
      });
    } catch (err) {
      if (accountId) releaseAccount(accountId);
      if (err instanceof AccountPoolExhaustedError || err instanceof LockedAccountUnavailableError) {
        return errorResponse(err.message, 503, 'pool_exhausted');
      }
      console.error('[/api/v1/chat/completions] Error:', err);
      return errorResponse(String(err), 502, 'upstream_error');
    }
  }

  // ── True streaming ─────────────────────────────────────────────────────────
  let accountId = '';
  let upstreamResponse: globalThis.Response | null = null;

  try {
    const { response, accountId: aid } = await openUpstream(model, pool, payloadStr, maxRetries);
    accountId = aid;
    upstreamResponse = response;
  } catch (err) {
    if (err instanceof AccountPoolExhaustedError || err instanceof LockedAccountUnavailableError) {
      return errorResponse(err.message, 503, 'pool_exhausted');
    }
    console.error('[/api/v1/chat/completions] Upstream error:', err);
    return errorResponse(String(err), 502, 'upstream_error');
  }

  // At this point we have a live upstream SSE connection. Stream it out.
  const completionId = `chatcmpl-${randomUUID()}`;
  const encoder = new TextEncoder();
  const upstreamBody = upstreamResponse.body!;

  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const delta = parseGoogleSSELine(line);
            if (delta === null) continue;

            const chunk = JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: delta },
                  finish_reason: null,
                },
              ],
            });
            enqueue(`data: ${chunk}\n\n`);
          }
        }

        // Flush any remaining buffer
        if (buffer) {
          const delta = parseGoogleSSELine(buffer);
          if (delta) {
            const chunk = JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            });
            enqueue(`data: ${chunk}\n\n`);
          }
        }

        // Final stop chunk
        const stopChunk = JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        enqueue(`data: ${stopChunk}\n\n`);
        enqueue('data: [DONE]\n\n');
      } catch (err) {
        // Mid-stream error — emit SSE error event before closing
        const errChunk = JSON.stringify({ error: String(err) });
        enqueue(`event: error\ndata: ${errChunk}\n\n`);
      } finally {
        reader.releaseLock();
        releaseAccount(accountId);
        controller.close();
      }
    },
    cancel() {
      releaseAccount(accountId);
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
