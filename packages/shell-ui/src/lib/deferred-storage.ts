/**
 * localStorage writes off the hot path.
 *
 * `localStorage.setItem` is synchronous and hits disk; a width dragged at
 * 60 fps or a recents list rewritten on every title tick was paying that
 * per frame. Writes are collected and flushed once, shortly after the last
 * one — and on `pagehide`, so a window closing mid-gesture loses nothing.
 * Reads still go straight to storage: nothing here is a cache.
 */

const FLUSH_MS = 250;

const pending = new Map<string, string>();
let timer: number | null = null;

export function writeStorageLater(key: string, value: string): void {
  pending.set(key, value);
  if (timer !== null || typeof window === "undefined") return;
  timer = window.setTimeout(flushStorageWrites, FLUSH_MS);
}

export function flushStorageWrites(): void {
  if (timer !== null && typeof window !== "undefined") window.clearTimeout(timer);
  timer = null;
  for (const [key, value] of pending) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage unavailable: these are conveniences, not state.
    }
  }
  pending.clear();
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushStorageWrites);
