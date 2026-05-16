import { vi } from 'vitest';

export function useFixedTime(iso = '2026-05-09T12:00:00.000Z'): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

export function restoreTime(): void {
  vi.useRealTimers();
}
