// src/test/QuotaBar.test.tsx
// Component tests for the QuotaBar UI.
// Verifies color logic, percentage display, ARIA attributes, and null state.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuotaBar } from '@/components/QuotaBar';

describe('QuotaBar', () => {
  describe('percentage display', () => {
    it('shows the correct percentage when value is provided', () => {
      render(<QuotaBar value={0.66} label="Weekly" />);
      expect(screen.getByText('66%')).toBeInTheDocument();
    });

    it('shows — when value is null', () => {
      render(<QuotaBar value={null} label="5-Hour" />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows 100% when value is 1.0', () => {
      render(<QuotaBar value={1.0} label="5-Hour" />);
      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('shows 0% when value is 0', () => {
      render(<QuotaBar value={0} label="Weekly" />);
      expect(screen.getByText('0%')).toBeInTheDocument();
    });

    it('rounds to the nearest integer', () => {
      render(<QuotaBar value={0.666} label="Weekly" />);
      expect(screen.getByText('67%')).toBeInTheDocument();
    });
  });

  describe('bar color logic', () => {
    it('uses green (emerald) for ≥50%', () => {
      const { container } = render(<QuotaBar value={0.75} label="5-Hour" />);
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain('bg-emerald-500');
    });

    it('uses amber for 30–49%', () => {
      const { container } = render(<QuotaBar value={0.40} label="Weekly" />);
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain('bg-amber-400');
    });

    it('uses red for <30% (but > 0)', () => {
      const { container } = render(<QuotaBar value={0.15} label="Weekly" />);
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain('bg-red-500');
    });

    it('uses slate (gray) when value is null', () => {
      const { container } = render(<QuotaBar value={null} label="5-Hour" />);
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain('bg-slate-600');
    });

    it('uses slate (gray) when value is 0 (empty)', () => {
      const { container } = render(<QuotaBar value={0} label="Weekly" />);
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain('bg-slate-600');
    });

    it('overrides to red when isBlocked is true regardless of value', () => {
      const { container } = render(<QuotaBar value={0.99} label="5-Hour" isBlocked />);
      const bar = container.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain('bg-red-500');
      expect(bar.className).not.toContain('bg-emerald-500');
    });
  });

  describe('accessibility', () => {
    it('sets correct aria-valuenow', () => {
      render(<QuotaBar value={0.66} label="Weekly" />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '66');
    });

    it('sets aria-valuenow to 0 when value is null', () => {
      render(<QuotaBar value={null} label="5-Hour" />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '0');
    });

    it('has correct aria-valuemin and aria-valuemax', () => {
      render(<QuotaBar value={0.5} label="Test" />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
    });

    it('has a descriptive aria-label', () => {
      render(<QuotaBar value={0.66} label="Gemini Weekly" />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-label', 'Gemini Weekly: 66% remaining');
    });

    it('renders the label text', () => {
      render(<QuotaBar value={0.5} label="Anthropic 5-Hour" />);
      expect(screen.getByText('Anthropic 5-Hour')).toBeInTheDocument();
    });
  });

  describe('bar width', () => {
    it('clamps width to 100% when value exceeds 1', () => {
      const { container } = render(<QuotaBar value={1.5} label="Test" />);
      const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
      expect(bar.style.width).toBe('100%');
    });

    it('clamps width to 0% when value is negative', () => {
      const { container } = render(<QuotaBar value={-0.5} label="Test" />);
      const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
      expect(bar.style.width).toBe('0%');
    });
  });
});
