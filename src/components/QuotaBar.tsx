// src/components/QuotaBar.tsx
// Color-coded quota progress bar.
// Colors: ≥50% green, 30-50% amber, <30% red, 0% or null gray.
'use client';

interface QuotaBarProps {
  /** 0–1 fraction, or null if not yet fetched */
  value: number | null;
  label: string;
  id?: string;
  isBlocked?: boolean;
}

function getBarColor(value: number | null): string {
  if (value === null) return 'bg-slate-600';
  const pct = value * 100;
  if (pct <= 0) return 'bg-slate-600';
  if (pct < 30) return 'bg-red-500';
  if (pct < 50) return 'bg-amber-400';
  return 'bg-emerald-500';
}

function getTextColor(value: number | null): string {
  if (value === null) return 'text-slate-400';
  const pct = value * 100;
  if (pct <= 0) return 'text-slate-400';
  if (pct < 30) return 'text-red-400';
  if (pct < 50) return 'text-amber-300';
  return 'text-emerald-400';
}

export function QuotaBar({ value, label, id, isBlocked }: QuotaBarProps) {
  const pct = value !== null ? Math.round(value * 100) : null;
  const barWidth = value !== null ? `${Math.max(0, Math.min(100, value * 100))}%` : '0%';
  const barColor = isBlocked ? 'bg-red-500' : getBarColor(value);
  const textColor = isBlocked ? 'text-red-400' : getTextColor(value);

  return (
    <div className="space-y-1.5" id={id}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400 font-medium">{label}</span>
        <span className={`font-bold tabular-nums ${textColor}`}>
          {pct !== null ? `${pct}%` : '—'}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-700/60 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barColor}`}
          style={{ width: barWidth }}
          role="progressbar"
          aria-valuenow={pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label}: ${pct !== null ? pct + '%' : 'unknown'} remaining`}
        />
      </div>
    </div>
  );
}
