import type { Metadata, Viewport } from "next";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@pistachio/live-share/styles.css";
import "./live.css";

/**
 * A live share's guest page (docs/live-share.md §7): a room someone was
 * invited into by a private link, so it is never indexed, never sends the
 * link on as a referrer, and has the screen to itself.
 */
export const metadata: Metadata = {
  title: "Live share · Pistachio",
  description: "Join a space shared live from Pistachio.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#16171b" },
    { media: "(prefers-color-scheme: light)", color: "#f3f4f6" },
  ],
};

export default function LiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
