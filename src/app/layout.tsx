// src/app/layout.tsx — Root layout
import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { QueryProvider } from '@/components/QueryProvider';

const plusJakarta = Plus_Jakarta_Sans({
  variable: '--font-plus-jakarta-sans',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Antigravity Quota Dashboard',
  description: 'Monitor quota usage across multiple Antigravity accounts — Gemini and Anthropic pools with 5-hour and weekly windows.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // .variable sets the CSS custom property; .className sets font-family directly
  const fontClasses = `${plusJakarta.variable} ${plusJakarta.className} ${jetbrainsMono.variable}`;

  return (
    <html lang="en" className={`dark ${plusJakarta.variable} ${jetbrainsMono.variable}`}>
      <body className={`${fontClasses} antialiased bg-slate-950 text-slate-100 min-h-screen`}>
        <QueryProvider>
          {children}
        </QueryProvider>
      </body>
    </html>
  );
}
