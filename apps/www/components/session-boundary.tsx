"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionBoundary as AccountBoundary } from "@pistachio/web-account";

function isSessionRoute(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname === "/onboarding/imessage";
}

/**
 * Keep one provider mounted while onboarding enters the app, and none at all
 * on the marketing pages. A direct app visit restores the saved device, while
 * an onboarding visit deliberately starts signed out so the secure link
 * chooses the account it will connect; the package freezes that choice for the
 * mounted session, so changing routes cannot restart restoration and overwrite
 * freshly unlocked keys.
 *
 * This site enrols as "Web". The browser app is its own origin with its own
 * device keys, and enrols as "Browser" (docs/web-browser-design.md §15).
 */
export function SessionBoundary({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  return (
    <AccountBoundary
      active={isSessionRoute(pathname)}
      autoRestore={pathname !== "/onboarding/imessage"}
      deviceName="Web"
    >
      {children}
    </AccountBoundary>
  );
}
