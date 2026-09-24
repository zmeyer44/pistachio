import { actionStats } from "../lib/site-data";
import { SectionLabel } from "./primitives";
import { VideoCard } from "./video-card";

/**
 * Below 1200px this reads heading → video → stats in one column, with the
 * heading separated by a full section gap. At desktop the three pieces become
 * a 12-column row: video on the left, heading and stats stacked on the right.
 */
export function SeeInAction() {
  return (
    <section
      id="memory"
      className="shell flex flex-col gap-16 pb-20 desk:gap-20"
    >
      <SectionLabel>Memory and privacy</SectionLabel>

      <div className="flex flex-col gap-16 desk:grid desk:grid-cols-12 desk:gap-x-6 desk:gap-y-0">
        <div className="flex flex-col gap-2 desk:col-span-4 desk:col-start-9 desk:row-start-1 desk:pr-6">
          <h2 className="text-32 text-ink desk:text-40">
            It remembers what you tell it, and keeps that on your Mac
          </h2>
          <p className="text-16 text-ink desk:text-20">
            Say “remember I prefer window seats” or “forget my old address” and
            the agent updates one local file you can read, edit, or erase in
            Settings.
          </p>
        </div>

        <div className="flex flex-col gap-6 desk:contents">
          <VideoCard
            poster="/img/09vujjR6SCsw346jin3ATXDR0.png"
            src="/video/feat-2lbzsWIPWwY0.mp4"
            label="Memory and reminders in practice"
            className="aspect-video w-full desk:col-span-8 desk:row-start-1 desk:aspect-auto desk:h-[518px]"
          />

          <div className="flex flex-col gap-6 tab:flex-row desk:col-span-4 desk:col-start-9 desk:row-start-1 desk:flex-col desk:self-end desk:pr-6">
            {actionStats.map((s) => (
              <div
                key={s.stat}
                className="flex flex-col tab:flex-1 desk:flex-none"
              >
                <p className="text-32 text-ink desk:text-40">{s.stat}</p>
                <p className="text-14 text-ink desk:text-16">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
