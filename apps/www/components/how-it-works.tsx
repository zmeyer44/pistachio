import { steps } from "../lib/site-data";
import { TOUR_SCENES, WALLPAPER } from "./hero-browser/tour-protocol";
import { SectionLabel } from "./primitives";

const HEADING = "A browser that pulls its weight.";
const SUBHEAD =
  "An agent that works inside your tabs, and the everyday moves — glance, split, reader, media — built in around it.";

/**
 * Where the live browser sits beside the steps: a desk with an empty slot,
 * the box the window fills. The window is the hero's own (components/live-
 * browser.tsx); it flies down onto this slot, takes the slot's proportions
 * (within a browser window's range), and plays each step on the real shell
 * as it comes up (components/hero-browser/tour.tsx), in place of a screen
 * recording.
 */
function StepsDesk({ className, slotClassName }: { className: string; slotClassName: string }) {
  return (
    <div
      data-tour-desk=""
      className={`relative overflow-hidden rounded-2xl bg-cover bg-center ${className}`}
      style={{ backgroundImage: `url("${WALLPAPER.src}")` }}
    >
      <div data-tour-slot="steps" className={`absolute ${slotClassName}`} />
    </div>
  );
}

export function HowItWorks() {
  return (
    <section
      id="agent"
      className="shell flex flex-col items-center gap-20 pt-2 pb-20"
    >
      <SectionLabel>Core features</SectionLabel>

      {/*
        Phone + tablet: the desk sticks under the nav and the steps scroll up
        beneath it, so the one window can stay in view while every step
        passes. The desk is capped at half the viewport's height so a wide,
        short screen still has room to read. Its cream ground (and the fade
        under it) covers the text sliding beneath; the band above it covers
        the gap to the nav.
      */}
      <div className="flex w-full flex-col gap-10 desk:hidden">
        <div className="flex flex-col gap-2">
          <h2 className="text-28 text-ink tab:text-32">{HEADING}</h2>
          <p className="text-14 text-ink tab:text-16">{SUBHEAD}</p>
        </div>

        <div className="relative">
          <div
            data-tour-sticky=""
            className="sticky top-[68px] z-10 bg-cream pb-2 before:absolute before:inset-x-0 before:bottom-full before:h-[80px] before:bg-cream after:absolute after:inset-x-0 after:top-full after:h-12 after:bg-[linear-gradient(to_bottom,var(--color-cream),transparent)] md:top-[76px]"
          >
            <StepsDesk
              className="mx-auto aspect-[16/10] w-full max-w-[calc((100svh-76px)*0.5*1.6)]"
              slotClassName="top-1/2 left-1/2 aspect-[5/3] w-[94%] -translate-x-1/2 -translate-y-1/2 tab:w-[88%]"
            />
          </div>

          <div className="flex flex-col">
            {steps.map((s, i) => (
              <div
                key={s.n}
                data-tour-step={TOUR_SCENES[i]}
                className="flex min-h-[60svh] flex-col gap-2 pt-12"
              >
                <div data-tour-mark="" className="flex items-center gap-4">
                  <h3 className="text-24 text-ink">{s.n}</h3>
                  <h3 className="text-24 text-ink">{s.title}</h3>
                </div>
                <p className="text-16 text-ink">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/*
        Desktop: the heading and the desk are one sticky layer above the
        panels (z-10), so they stay put while each step's text slides up and
        covers the one before; the text column carries the page background to
        do the covering.

        The layer is positioned absolutely across the whole wrapper, so it
        takes no flow space yet shares the panels' sticky containing block
        and height (--panel-h). Everything therefore unsticks at the same
        scroll position and the section exits as a unit. (A negative margin
        can't do this: sticky constrains the margin box.) The live browser
        reads the same layout to know where the desk's slot will be at any
        scroll position (components/live-browser.tsx).
      */}
      <div className="relative hidden w-full flex-col gap-[240px] pb-6 [--panel-h:max(600px,calc(100dvh-92px-24px))] desk:flex">
        <div className="pointer-events-none absolute inset-0 z-10">
          <div
            data-tour-sticky=""
            className="sticky top-[92px] grid h-(--panel-h) grid-cols-12 gap-6"
          >
            {/* Bottom edge fades out so text sliding under the heading dissolves rather than being clipped. */}
            <div className="pointer-events-auto col-span-4 flex flex-col gap-2 self-start bg-[linear-gradient(to_bottom,var(--color-cream)_calc(100%-96px),transparent)] pb-[120px]">
              <h2 className="text-40 text-ink">{HEADING}</h2>
              <p className="text-16 text-ink">{SUBHEAD}</p>
            </div>
            {/*
              The desk fills the column and as much of the panel's height as
              a window could use (never taller than 1.2:1); the window fills
              the desk inside the same gutter the hero's desk leaves.
            */}
            <div className="col-span-7 col-start-6 min-h-0">
              <StepsDesk className="aspect-[1.2] max-h-full w-full" slotClassName="inset-[clamp(20px,4.5%,40px)]" />
            </div>
          </div>
        </div>

        {steps.map((s, i) => (
          <div
            key={s.n}
            data-tour-step={TOUR_SCENES[i]}
            className="sticky top-[92px] grid h-(--panel-h) grid-cols-12 gap-6"
          >
            {/* Top edge fades in so the previous step's text dissolves rather than being clipped. */}
            <div className="col-span-4 flex flex-col justify-end gap-2 bg-[linear-gradient(to_bottom,transparent,var(--color-cream)_320px)]">
              <p data-tour-mark="" className="text-88 text-ink">{s.n}</p>
              <h3 className="text-32 text-ink">{s.title}</h3>
              <p className="mt-2 text-20 text-ink">{s.body}</p>
            </div>
          </div>
        ))}

        <div className="h-[222px]" aria-hidden="true" />
      </div>
    </section>
  );
}
