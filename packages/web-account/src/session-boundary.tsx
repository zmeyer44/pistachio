"use client";

import { useState, type ReactNode } from "react";
import { SessionProvider } from "./session";
import type { WebDeviceName } from "./device";

/**
 * One mounted session for as long as the app is open.
 *
 * `autoRestore` is frozen for this mounted boundary: a direct visit restores
 * the saved device, while an onboarding visit deliberately starts signed out
 * so the secure link chooses the account it will connect. Changing routes must
 * not restart restoration and overwrite freshly unlocked keys, so the initial
 * choice is captured in state and never read again.
 *
 * `active` is what the dashboard uses to keep the provider off its marketing
 * pages (docs/web-browser-design.md §15); the browser app is nothing but the
 * signed-in app, so it leaves it alone.
 */
export function SessionBoundary({
  active = true,
  autoRestore = true,
  children,
  deviceName,
}: {
  active?: boolean;
  autoRestore?: boolean;
  children: ReactNode;
  deviceName: WebDeviceName;
}): ReactNode {
  const [initialAutoRestore] = useState(autoRestore);
  if (!active) return children;
  return (
    <SessionProvider autoRestore={initialAutoRestore} deviceName={deviceName}>
      {children}
    </SessionProvider>
  );
}
