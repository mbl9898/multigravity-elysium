// src/components/CountdownTimer.tsx
// Live client-side countdown timer.
// Takes a resetTime ISO 8601 string and displays "Xh Ym" or "X days Yh" or "Resetting..."
'use client';

import { useEffect, useState } from 'react';

interface CountdownTimerProps {
  resetTime: string | null;
  className?: string;
}

function formatCountdownWithNow(targetIso: string, now: number): string {
  const target = new Date(targetIso).getTime();
  const diffMs = target - now;

  if (diffMs <= 0) return 'Resetting…';

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

const getNow = () => Date.now();

export function CountdownTimer({ resetTime, className }: CountdownTimerProps) {
  const [now, setNow] = useState(getNow);

  useEffect(() => {
    if (!resetTime) return;

    const interval = setInterval(() => {
      setNow(getNow());
    }, 1000);

    return () => clearInterval(interval);
  }, [resetTime]);

  const display = resetTime ? formatCountdownWithNow(resetTime, now) : '—';

  return <span className={className}>{display}</span>;
}

