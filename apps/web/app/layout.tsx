import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SessionBoundary } from "@pistachio/web-account";
import "./globals.css";

/**
 * Pistachio in a browser tab (docs/web-browser-design.md §15).
 *
 * This app is the shell and nothing else: one route, at `/`, and everything
 * around it is the account layer both web apps share. The device it enrols is
 * named "Browser" so the dashboard's Devices page can tell this site from that
 * one — they are two origins, and device keys live in the origin's IndexedDB.
 */
export const metadata: Metadata = {
  title: "Pistachio",
  description: "Your browser, your agent, your signed-in tabs — from any browser.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>
        <SessionBoundary deviceName="Browser">
          <a className="pa-skip" href="#main">
            Skip to content
          </a>
          <main id="main" className="pa-browse">
            {children}
          </main>
        </SessionBoundary>
      </body>
    </html>
  );
}
