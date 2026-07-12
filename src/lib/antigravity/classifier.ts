// src/lib/antigravity/classifier.ts
// Classifies an Antigravity model name into one of the known quota pools.
// This mirrors Antigravity's own client-side classification logic.

import type { InternalPool } from '@/types';

/**
 * Classify a model name into an internal quota pool.
 *
 * Rules (in priority order):
 *  1. Contains "claude" or "gpt" (case-insensitive) → claude_gpt
 *  2. Contains "gemini" AND version matches 3.x pattern → gemini3
 *  3. Contains "gemini" AND version matches 2.5 pattern → gemini2.5
 *  4. Anything else → unknown (show in UI but don't block on it)
 */
export function classifyModel(modelName: string): InternalPool {
  const name = modelName.toLowerCase();

  if (/claude|gpt/.test(name)) return 'claude_gpt';
  if (/gemini/.test(name) && /\b3\.\d/.test(name)) return 'gemini3';
  if (/gemini/.test(name) && /\b2\.5/.test(name)) return 'gemini2.5';
  return 'unknown';
}

/**
 * Returns the representative model to use for a weekly quota probe.
 * These are small, cheap models — the probe only sends "hi" with maxTokens: 10.
 */
export function getRepresentativeModel(displayPool: 'gemini' | 'anthropic'): string {
  return displayPool === 'gemini' ? 'gemini-3-flash' : 'claude-sonnet-4-6';
}
