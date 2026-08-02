// src/proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const url = request.nextUrl.clone();

  // 1. Intercept the language server's internal CloudCode autocomplete stream endpoint.
  if (url.pathname === '/v1internal:streamGenerateContent') {
    console.log('[MITM PROXY] Intercepted CloudCode stream request → rewriting to /api/v1internal/stream-generate-content');
    url.pathname = '/api/v1internal/stream-generate-content';
    return NextResponse.rewrite(url);
  }

  // 2. Intercept standard Gemini developer API requests (used by modeling thread/agent).
  if (url.pathname.startsWith('/v1/models/') || url.pathname.startsWith('/v1beta/models/')) {
    console.log(`[MITM PROXY] Intercepted Gemini developer request for path ${url.pathname} → rewriting to /api/gemini-proxy`);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-original-path', url.pathname);
    url.pathname = '/api/gemini-proxy';
    return NextResponse.rewrite(url, {
      request: {
        headers: requestHeaders,
      },
    });
  }

  return NextResponse.next();
}

// Broadly match all paths except Next.js assets/APIs, ensuring we capture both
// /v1internal:streamGenerateContent and standard Gemini developer endpoints.
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
