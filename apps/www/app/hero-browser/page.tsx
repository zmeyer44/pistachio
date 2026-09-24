"use client";

import dynamic from "next/dynamic";

/**
 * The shell is a browser program — its modules read `navigator` as they
 * evaluate — so it is never prerendered, and it is its own chunk: no other
 * route on the site carries the desktop's chrome.
 */
const loadShell = () => import("../../components/hero-browser/shell");
// Start fetching the shell's chunk as this module evaluates, not when React
// first renders the placeholder: the hero waits on this chunk and nothing else.
if (typeof window !== "undefined") void loadShell();
const HeroShell = dynamic(loadShell, { ssr: false });

export default function HeroBrowserPage() {
  return (
    <div className="hero-browser" data-testid="hero-browser">
      <HeroShell downloadUrl="/download" accountUrl="/app" />
    </div>
  );
}
