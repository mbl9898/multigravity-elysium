// src/components/QueryProvider.tsx
// TanStack Query client provider — wraps the app for server state management.
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,       // Consider data stale after 30s
            refetchInterval: 30_000, // Auto-refetch every 30s (server also polls every 60s)
            retry: 2,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
