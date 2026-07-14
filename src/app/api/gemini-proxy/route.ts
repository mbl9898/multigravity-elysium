// src/app/api/gemini-proxy/route.ts
// POST /api/gemini-proxy
//
// MITM proxy for standard Gemini API Developer requests (e.g. modelling threads).
// Intercepts requests meant for generativelanguage.googleapis.com, binds them to a
// healthy account from the pool, injects credentials, and streams the response.

import { NextRequest } from 'next/server';
import {
  selectAndLockAccount,
  releaseAccount,
  markExhausted,
  AccountPoolExhaustedError,
  LockedAccountUnavailableError,
} from '@/lib/router/accountRouter';

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(req: NextRequest): Promise<Response> {
  const originalPath = req.headers.get('x-original-path');
  if (!originalPath) {
    return errorResponse('Missing x-original-path header', 400);
  }

  const url = req.nextUrl;
  const queryParams = url.searchParams.toString();

  const bodyText = await req.text();

  // Always use the gemini pool for these developer API requests
  const pool = 'gemini';

  // Count active accounts for retry limits
  let maxRetries = 5;
  try {
    const { prisma } = await import('@/lib/database/client');
    const count = await prisma.account.count({ where: { isHealthy: true } });
    maxRetries = Math.max(count, 1);
  } catch { /* fallback to 5 */ }

  let attempt = 0;
  let accountId = '';
  let upstreamResponse: Response | null = null;

  while (attempt <= maxRetries) {
    try {
      const selected = await selectAndLockAccount(pool);
      accountId = selected.accountId;
      console.log(`[GEMINI PROXY] Selected account: ${selected.email} (id: ${selected.accountId}) for path ${originalPath}`);

      // Copy headers, swapping Authorization for the selected account's access token
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
      headers.set('Authorization', `Bearer ${selected.accessToken}`);

      const targetUrl = `https://generativelanguage.googleapis.com${originalPath}${queryParams ? '?' + queryParams : ''}`;
      
      const upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: bodyText,
      });

      if (upstream.status === 429 || upstream.status === 403) {
        releaseAccount(accountId);
        await markExhausted(accountId, pool);
        accountId = '';
        attempt++;
        continue; // try next account
      }

      if (!upstream.ok) {
        releaseAccount(accountId);
        accountId = '';
        throw new Error(`HTTP ${upstream.status} from Google Developer API`);
      }

      upstreamResponse = upstream;
      break; // successfully connected
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
    return errorResponse('Failed to establish connection to upstream developer API', 502);
  }

  // Pass-through stream pipeline
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
        console.log(`[GEMINI PROXY] Stream closed. Released account: ${lockedId}`);
        controller.close();
      }
    },
    cancel() {
      releaseAccount(lockedId);
      console.log(`[GEMINI PROXY] Stream cancelled by client. Released account: ${lockedId}`);
    },
  });

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
