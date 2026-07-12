// src/test/classifier.test.ts
// Unit tests for the model pool classifier.
// These are pure function tests — no network, no DB, no env vars needed.

import { describe, it, expect } from 'vitest';
import { classifyModel, getRepresentativeModel } from '@/lib/antigravity/classifier';

describe('classifyModel', () => {
  describe('claude_gpt pool', () => {
    it('classifies claude models', () => {
      expect(classifyModel('claude-sonnet-4-6')).toBe('claude_gpt');
      expect(classifyModel('claude-3-5-haiku')).toBe('claude_gpt');
      expect(classifyModel('claude-opus-4')).toBe('claude_gpt');
    });

    it('is case-insensitive for claude', () => {
      expect(classifyModel('Claude-Sonnet')).toBe('claude_gpt');
      expect(classifyModel('CLAUDE-HAIKU')).toBe('claude_gpt');
    });

    it('classifies gpt models', () => {
      expect(classifyModel('gpt-4o')).toBe('claude_gpt');
      expect(classifyModel('gpt-4-turbo')).toBe('claude_gpt');
    });

    it('claude takes priority over gemini if both appear in the name', () => {
      expect(classifyModel('claude-gemini-hybrid')).toBe('claude_gpt');
    });
  });

  describe('gemini3 pool', () => {
    it('classifies gemini 3.x models', () => {
      expect(classifyModel('gemini-3-flash')).toBe('gemini3');
      expect(classifyModel('gemini-3.0-pro')).toBe('gemini3');
      expect(classifyModel('gemini-3.5-flash')).toBe('gemini3');
    });

    it('is case-insensitive for gemini 3.x', () => {
      expect(classifyModel('Gemini-3-Flash')).toBe('gemini3');
    });
  });

  describe('gemini2.5 pool', () => {
    it('classifies gemini 2.5 models', () => {
      expect(classifyModel('gemini-2.5-pro')).toBe('gemini2.5');
      expect(classifyModel('gemini-2.5-flash')).toBe('gemini2.5');
    });
  });

  describe('unknown pool', () => {
    it('returns unknown for unrecognised model names', () => {
      expect(classifyModel('llama-3')).toBe('unknown');
      expect(classifyModel('mistral-7b')).toBe('unknown');
      expect(classifyModel('')).toBe('unknown');
    });

    it('returns unknown for bare gemini with no version', () => {
      expect(classifyModel('gemini')).toBe('unknown');
    });
  });
});

describe('getRepresentativeModel', () => {
  it('returns a gemini model for the gemini pool', () => {
    const model = getRepresentativeModel('gemini');
    expect(model).toMatch(/gemini/i);
  });

  it('returns a claude model for the anthropic pool', () => {
    const model = getRepresentativeModel('anthropic');
    expect(model).toMatch(/claude/i);
  });
});
