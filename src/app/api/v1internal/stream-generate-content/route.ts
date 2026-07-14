// src/app/api/v1internal/stream-generate-content/route.ts
// POST /api/v1internal/stream-generate-content
//
// Man-in-the-Middle (MITM) proxy for Antigravity V2 (the IDE language server).
// Intercepts raw upstream Google CloudCode SSE requests, performs load-balanced
// account routing and credentials injection, and pipes the Google response stream
// back directly without any translation overhead.

import { NextRequest } from 'next/server';
import { CLOUDCODE_ENDPOINTS } from '@/lib/cloudcode/client';
import {
  selectAndLockAccount,
  releaseAccount,
  markExhausted,
  AccountPoolExhaustedError,
  LockedAccountUnavailableError,
} from '@/lib/router/accountRouter';

function getPoolForModel(modelName: string): 'gemini' | 'anthropic' {
  const name = modelName.toLowerCase();
  if (/claude|gpt|anthropic/.test(name)) {
    return 'anthropic';
  }
  return 'gemini';
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(req: NextRequest): Promise<Response> {
  const bodyText = await req.text();

  // 1. Determine target pool by parsing model name from payload
  let modelName = 'gemini-3-flash';
  try {
    const parsed = JSON.parse(bodyText) as { model?: string };
    if (parsed.model) {
      modelName = parsed.model;
    }
  } catch {
    console.error('[MITM PROXY] Failed to parse JSON body from request');
    return errorResponse('Invalid JSON payload', 400);
  }

  const pool = getPoolForModel(modelName);
  console.log(`[MITM PROXY] Intercepted request. Model: ${modelName}, Pool: ${pool}`);

  // 2. Count active accounts for retry limits
  let maxRetries = 5;
  try {
    const { prisma } = await import('@/lib/database/client');
    const count = await prisma.account.count({ where: { isHealthy: true } });
    maxRetries = Math.max(count, 1);
  } catch { /* fallback to 5 */ }

  let attempt = 0;
  let accountId = '';
  let upstreamResponse: Response | null = null;

  // 3. Keep trying accounts in the pool if we get rate-limited
  while (attempt <= maxRetries) {
    try {
      const selected = await selectAndLockAccount(pool);
      accountId = selected.accountId;
      console.log(`[MITM PROXY] Selected account: ${selected.email} (id: ${selected.accountId})`);

      // Copy incoming headers from the IDE, omitting standard/hop-by-hop ones
      const headers = new Headers();
      req.headers.forEach((val, key) => {
        const lowerKey = key.toLowerCase();
        if (
          [
            'host',
            'connection',
            'content-length',
            'accept-encoding',
            'authorization',
          ].includes(lowerKey)
        ) {
          return;
        }
        headers.set(key, val);
      });
      // Inject selected account's access token
      headers.set('Authorization', `Bearer ${selected.accessToken}`);

      for (const baseUrl of CLOUDCODE_ENDPOINTS) {
        try {
          const upstream = await fetch(
            `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
            {
              method: 'POST',
              headers,
              body: bodyText,
            },
          );

          if (upstream.status === 429 || upstream.status === 403) {
            releaseAccount(accountId);
            await markExhausted(accountId, pool);
            accountId = '';
            attempt++;
            break; // try next account in the outer loop
          }

          if (!upstream.ok) {
            releaseAccount(accountId);
            accountId = '';
            throw new Error(`HTTP ${upstream.status} from ${baseUrl}`);
          }

          upstreamResponse = upstream;
          break; // successfully opened upstream
        } catch (err) {
          if (
            err instanceof AccountPoolExhaustedError ||
            err instanceof LockedAccountUnavailableError
          ) {
            throw err;
          }
          // Network issues — try next CloudCode API endpoint
          if (
            CLOUDCODE_ENDPOINTS.indexOf(baseUrl as typeof CLOUDCODE_ENDPOINTS[number]) ===
            CLOUDCODE_ENDPOINTS.length - 1
          ) {
            if (accountId) {
              releaseAccount(accountId);
              accountId = '';
            }
            throw err;
          }
        }
      }

      if (upstreamResponse) {
        break; // break outer loop once successfully connected
      }
    } catch (err) {
      if (accountId) {
        releaseAccount(accountId);
        accountId = '';
      }
      if (
        err instanceof AccountPoolExhaustedError ||
        err instanceof LockedAccountUnavailableError
      ) {
        return errorResponse(err.message, 503);
      }
      if (attempt >= maxRetries) {
        return errorResponse(`Upstream error: ${String(err)}`, 502);
      }
      attempt++;
    }
  }

  if (!upstreamResponse || !accountId) {
    return errorResponse('Failed to establish connection to upstream', 502);
  }

  // 4. Pass-through stream pipeline
  const lockedId = accountId;
  const upstreamBody = upstreamResponse.body!;
  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
        releaseAccount(lockedId);
        console.log(`[MITM PROXY] Stream closed. Released account: ${lockedId}`);
        controller.close();
      }
    },
    cancel() {
      releaseAccount(lockedId);
      console.log(`[MITM PROXY] Stream cancelled by client. Released account: ${lockedId}`);
    },
  });

  // Forward Google's original headers (Content-Type, etc.)
  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((val, key) => {
    if (['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
      return;
    }
    responseHeaders.set(key, val);
  });

  return new Response(readable, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
