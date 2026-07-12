// src/app/chat/layout.tsx — Wraps chat page with QueryProvider
import { QueryProvider } from '@/components/QueryProvider';

export const metadata = {
  title: 'Gemini Chat — Antigravity Dashboard',
  description: 'Chat with Gemini models via your Antigravity account',
};

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
