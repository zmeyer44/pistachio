import type { Metadata } from "next";
import "./hero-browser.css";

/**
 * The frame the landing page's hero embeds (components/hero-desktop.tsx): the
 * shell over an in-memory host, dressed as the desktop. Not a page anyone
 * navigates to, so it is kept out of the index.
 */
export const metadata: Metadata = {
  title: "Pistachio preview",
  robots: { index: false, follow: false },
};

export default function HeroBrowserLayout({ children }: { children: React.ReactNode }) {
  return children;
}
