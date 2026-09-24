"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { navLinks } from "../lib/site-data";
import { cn } from "../lib/utils";
import { ArrowRight, BrandMark } from "./primitives";
import { Button } from "./ui/button";

/**
 * Floating pill navigation.
 *
 * Layout tiers match the reference: the link row appears at >=1024px, the
 * "Docs" link at >=768px, and the CTA is always visible. Below 1024px a
 * hamburger opens a full-height sheet that hangs off the bottom of the pill.
 */
export function SiteNav() {
  const [open, setOpen] = useState(false);
  const scrolled = useScrolledPast(40);

  // Lock body scroll while the sheet is open, and close it on Escape.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The sheet only exists below 1024px - close it if the viewport grows past.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => mq.matches && setOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-2 pt-3 md:pt-5">
      <div
        className={cn(
          "mx-auto flex h-14 w-full items-center rounded-[10px] border border-track bg-paper/80 px-2 backdrop-blur-[4px]",
          "transition-[max-width] duration-300 ease-out motion-reduce:transition-none",
          // Wide at rest, tightening once the page scrolls. Below ~1336px both
          // caps exceed the available width, so the effect is desktop-only
          // without needing a media query.
          scrolled ? "max-w-[1320px]" : "max-w-[1440px]",
        )}
      >
        <div className="flex w-full items-center justify-between gap-4">
          {/* left: wordmark + links */}
          <div className="flex items-center gap-5">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2 px-2"
              onClick={() => setOpen(false)}
            >
              {/* Mark is decorative — the wordmark beside it names the link. */}
              <BrandMark
                name="pistachio-mark"
                className="h-6 sm:h-[26px] md:h-[30px]"
                style={{ aspectRatio: "22 / 23" }}
              />
              <span className="text-[15px] leading-none font-semibold tracking-[-0.02em] text-ink sm:text-[16px] md:text-[18px]">
                Pistachio
              </span>
            </Link>
            <DesktopLinks />
          </div>

          {/* right: sign in + CTA + menu toggle */}
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/docs"
              className="hidden rounded-lg px-4 py-2 text-14 font-medium text-ink transition-colors hover:bg-tile hover:text-green md:block"
            >
              Docs
            </Link>

            <Button asChild className="px-3 sm:px-4 md:px-5">
              <Link href="/early-access">
                <span className="hidden sm:inline">Get early access</span>
                <span className="sm:hidden">Early access</span>
                <ArrowRight size={16} />
              </Link>
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="mobile-menu"
              className="text-ink lg:hidden"
            >
              {open ? <CloseIcon /> : <MenuIcon />}
            </Button>
          </div>
        </div>
      </div>

      <MobileSheet open={open} onClose={() => setOpen(false)} />
    </header>
  );
}

/**
 * True once the page has scrolled past `offset`. Reads are coalesced into one
 * rAF per frame, and the initial value is taken on mount so a page that loads
 * part-way down starts in the right state.
 */
function useScrolledPast(offset: number) {
  const [past, setPast] = useState(false);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setPast(window.scrollY > offset);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [offset]);

  return past;
}

/**
 * Link row with a single highlight pill that slides and resizes between items,
 * rather than each link carrying its own hover background.
 */
function DesktopLinks() {
  const [active, setActive] = useState<number | null>(null);
  const items = useRef<(HTMLAnchorElement | null)[]>([]);
  const [pill, setPill] = useState({ left: 0, width: 0 });

  useEffect(() => {
    if (active === null) return;
    const el = items.current[active];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active]);

  return (
    <nav
      className="relative hidden items-center gap-1 lg:flex"
      onMouseLeave={() => setActive(null)}
    >
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 h-full rounded-lg bg-tile transition-[transform,width,opacity] duration-[280ms] ease-out"
        style={{
          transform: `translateX(${pill.left}px)`,
          width: pill.width,
          opacity: active === null ? 0 : 1,
        }}
      />
      {navLinks.map((l, i) => (
        <Link
          key={l.label}
          href={l.href}
          ref={(el) => {
            items.current[i] = el;
          }}
          onMouseEnter={() => setActive(i)}
          onFocus={() => setActive(i)}
          className="relative rounded-lg px-4 py-2 text-14 font-medium whitespace-nowrap text-ink"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

/** Full-height sheet that hangs below the pill on tablet and phone. */
function MobileSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <div
      id="mobile-menu"
      hidden={!open}
      className={cn(
        "fixed inset-x-2 bottom-0 flex flex-col overflow-hidden rounded-t-[18px]",
        "border border-green/10 bg-paper/95 backdrop-blur-md lg:hidden",
        "top-[68px] md:top-[76px]",
      )}
    >
      <div className="overflow-y-auto p-3">
        <ul className="flex flex-col gap-1">
          {navLinks.map((l) => (
            <li key={l.label}>
              <Link
                href={l.href}
                onClick={onClose}
                className="block rounded-[10px] px-3 py-2.5 text-16 font-medium text-ink transition-colors hover:bg-tile"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto flex flex-col gap-2 p-3">
        <Link
          href="/docs"
          onClick={onClose}
          className="inline-flex h-10 w-fit items-center rounded-md px-4 text-14 font-medium text-ink transition-colors hover:bg-tile md:hidden"
        >
          Docs
        </Link>
        <Button asChild className="w-full">
          <Link href="/early-access" onClick={onClose}>
            Get early access
            <ArrowRight size={16} />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3.5 7h17M3.5 12h17M3.5 17h17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
