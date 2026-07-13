// src/app/api/v1/messages/route.ts
// POST /api/v1/messages — Anthropic-compatible gateway endpoint.
//
// Accepts the native Anthropic Messages API request shape and returns
// Anthropic-format SSE events or a synchronous JSON message object.
// Internally routes through the same Elysium account router and Google
// CloudCode proxy as the OpenAI-compatible endpoint.
//
// No auth — localhost-only. Security enforced by the AI CLI Gateway.

import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  CLOUDCODE_ENDPOINTS,
  MODEL_POOL_MAP,
  buildRequestHeaders,
  buildClaudePayload,
  buildGeminiPayload,
  parseGoogleSSELine,
  extractTextFromSSE,
} from '@/lib/cloudcode/client';
import { collapseAnthropicMessages } from '@/lib/cloudcode/collapse';
import {
  selectAndLockAccount,
  releaseAccount,
  markExhausted,
  AccountPoolExhaustedError,
  LockedAccountUnavailableError,
} from '@/lib/router/accountRouter';

// ─── Request schema ───────────────────────────────────────────────────────────

interface AnthropicRequest {
  model: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string }>;
  }>;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResponse(message: string, status: number, type = 'api_error'): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

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
          break;
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
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_request_error');
  }

  const { model, messages, system, max_tokens = 8192, temperature, stream = false } = body;

  if (!model || !messages?.length) {
    return errorResponse('model and messages are required', 400, 'invalid_request_error');
  }

  const pool = MODEL_POOL_MAP[model];
  if (!pool) {
    return errorResponse(
      `Unknown model: ${model}. Supported: ${Object.keys(MODEL_POOL_MAP).join(', ')}`,
      400,
      'invalid_request_error',
    );
  }

  console.log(`[ELYSIUM PROXY] /v1/messages → model: ${model}, pool: ${pool}`);

  const { messages: collapsed, systemPrompt } = collapseAnthropicMessages(messages, system);

  const payloadObj =
    pool === 'anthropic'
      ? buildClaudePayload(model, collapsed, {
          maxOutputTokens: max_tokens,
          temperature,
          systemPrompt: systemPrompt || undefined,
        })
      : buildGeminiPayload(model, collapsed, { maxOutputTokens: max_tokens, temperature });

  const payloadStr = JSON.stringify(payloadObj);

  let maxRetries = 5;
  try {
    const { prisma } = await import('@/lib/database/client');
    const count = await prisma.account.count({ where: { isHealthy: true } });
    maxRetries = Math.max(count, 1);
  } catch { /* use default */ }

  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  // ── Non-streaming ──────────────────────────────────────────────────────────
  if (!stream) {
    let accountId = '';
    try {
      const { response, accountId: aid } = await openUpstream(model, pool, payloadStr, maxRetries);
      accountId = aid;
      const rawText = await response.text();
      const text = extractTextFromSSE(rawText);
      releaseAccount(accountId);
      return Response.json({
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } catch (err) {
      if (accountId) releaseAccount(accountId);
      if (err instanceof AccountPoolExhaustedError || err instanceof LockedAccountUnavailableError) {
        return errorResponse(err.message, 503, 'overloaded_error');
      }
      console.error('[/api/v1/messages] Error:', err);
      return errorResponse(String(err), 502, 'api_error');
    }
  }

  // ── True streaming — Anthropic SSE event format ────────────────────────────
  let accountId = '';
  let upstreamResponse: globalThis.Response | null = null;

  try {
    const { response, accountId: aid } = await openUpstream(model, pool, payloadStr, maxRetries);
    accountId = aid;
    upstreamResponse = response;
  } catch (err) {
    if (err instanceof AccountPoolExhaustedError || err instanceof LockedAccountUnavailableError) {
      return errorResponse(err.message, 503, 'overloaded_error');
    }
    console.error('[/api/v1/messages] Upstream error:', err);
    return errorResponse(String(err), 502, 'api_error');
  }

  const encoder = new TextEncoder();
  const upstreamBody = upstreamResponse.body!;

  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let outputTokens = 0;

      const sse = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      try {
        // message_start
        sse('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        // content_block_start
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });

        // ping
        sse('ping', { type: 'ping' });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const delta = parseGoogleSSELine(line);
            if (delta === null) continue;
            outputTokens += Math.ceil(delta.length / 4); // rough estimate
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta },
            });
          }
        }

        // Flush remaining buffer
        if (buffer) {
          const delta = parseGoogleSSELine(buffer);
          if (delta) {
            outputTokens += Math.ceil(delta.length / 4);
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta },
            });
          }
        }

        sse('content_block_stop', { type: 'content_block_stop', index: 0 });

        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });

        sse('message_stop', { type: 'message_stop' });
      } catch (err) {
        sse('error', { type: 'error', error: { type: 'api_error', message: String(err) } });
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
