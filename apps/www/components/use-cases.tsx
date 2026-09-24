"use client";

import { useEffect, useRef, useState } from "react";
import { useCases } from "../lib/site-data";
import { SectionLabel } from "./primitives";

/**
 * Cross-fading stack of clips; each use case owns one. Only the active clip
 * plays (from the start), and finishing it advances the rotation — clip
 * lengths vary too much for a fixed dwell. While paused the active clip
 * replays instead.
 */
function VideoStack({
  active,
  paused,
  onEnded,
}: {
  active: number;
  paused: boolean;
  onEnded: () => void;
}) {
  const videos = useRef<(HTMLVideoElement | null)[]>([]);

  useEffect(() => {
    videos.current.forEach((v, i) => {
      if (v === null) return;
      if (i === active) {
        v.currentTime = 0;
        void v.play().catch(() => {});
      } else {
        v.pause();
      }
    });
  }, [active]);

  return (
    <div className="relative aspect-[1572/1080] w-full overflow-hidden">
      {useCases.map((u, i) => (
        <video
          key={u.n}
          ref={(el) => {
            videos.current[i] = el;
          }}
          src={u.video}
          poster={u.poster}
          muted
          playsInline
          preload="metadata"
          aria-hidden={i !== active}
          onEnded={(e) => {
            if (paused) {
              e.currentTarget.currentTime = 0;
              void e.currentTarget.play().catch(() => {});
            } else {
              onEnded();
            }
          }}
          className="absolute inset-0 size-full object-cover transition-opacity duration-700"
          style={{ opacity: i === active ? 1 : 0 }}
        />
      ))}
    </div>
  );
}

export function UseCases() {
  const [active, setActive] = useState(0);
  // Auto-rotation pauses while the pointer is over the list, so a hovered
  // item stays put; it resumes from the hovered item on leave.
  const [paused, setPaused] = useState(false);

  return (
    <section
      id="spaces"
      className="shell flex flex-col gap-16 pt-2 pb-20 desk:gap-20"
    >
      <SectionLabel>The browser</SectionLabel>

      <div className="flex flex-col gap-20">
        <div className="flex flex-col gap-2 desk:grid desk:grid-cols-12 desk:gap-6">
          <h2 className="text-32 text-ink desk:col-span-5 desk:text-40">
            A good browser on its own
          </h2>
          <p className="text-16 text-ink desk:col-span-7 desk:col-start-6 desk:text-32">
            Everything you expect from a modern sidebar browser, with the same
            features whether you keep tabs on the side or on top.
          </p>
        </div>

        <div className="flex flex-col gap-4 desk:grid desk:grid-cols-12 desk:gap-6">
          {/* imagery — above the list on phones, beside it on desktop */}
          <div className="desk:col-span-7 desk:col-start-6 desk:row-start-1">
            <VideoStack
              active={active}
              paused={paused}
              onEnded={() => setActive((i) => (i + 1) % useCases.length)}
            />
          </div>

          {/* accordion */}
          <div
            className="flex flex-col desk:col-span-5 desk:col-start-1 desk:row-start-1 desk:justify-end"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            {useCases.map((u, i) => {
              const open = i === active;
              return (
                <button
                  key={u.n}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onClick={() => setActive(i)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-4 py-5 text-left shadow-[inset_0_-1px_0_0_var(--color-green)] first:pt-0 last:pb-0 last:shadow-none desk:gap-6 desk:py-6"
                >
                  <span className="w-6 shrink-0 text-20 text-ink desk:w-[49px] desk:text-24">
                    {u.n}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-20 text-ink desk:text-24">
                      {u.title}
                    </span>
                    <span
                      className="grid transition-[grid-template-rows,opacity] duration-500"
                      style={{
                        gridTemplateRows: open ? "1fr" : "0fr",
                        opacity: open ? 1 : 0,
                      }}
                    >
                      <span className="overflow-hidden">
                        <span className="block max-w-[300px] pt-2 text-16 text-ink">
                          {u.body}
                        </span>
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
