import { caseStudies } from "../lib/site-data";
import { ArrowTiny, SectionLabel } from "./primitives";
import { VideoCard } from "./video-card";

/**
 * Three customer stories. Below 1200px they become a horizontally scrollable
 * rail, which is why the section drops its own gutters at those widths.
 */
export function CaseStudies() {
  return (
    <section className="mx-auto flex w-full max-w-[1512px] flex-col items-center gap-16 pt-2 pb-20 desk:gap-20">
      <div className="w-full px-4 desk:px-6">
        <SectionLabel>Everyday tasks</SectionLabel>
      </div>

      <div className="flex w-full flex-col items-center gap-20">
        <h2 className="w-full px-4 text-32 text-ink desk:px-6 desk:text-center desk:text-40">
          Three things to try on day one
        </h2>

        <div className="flex w-full snap-x snap-mandatory gap-[9px] overflow-x-auto px-4 [scrollbar-width:none] desk:grid desk:grid-cols-3 desk:gap-6 desk:overflow-visible desk:px-6">
          {caseStudies.map((c) => (
            <article
              key={c.name}
              className="flex w-[calc(100vw-32px)] shrink-0 snap-start flex-col gap-3 tab:w-[622px] desk:w-auto"
            >
              <VideoCard
                poster={c.poster}
                src={c.video}
                label={c.name}
                className="aspect-video w-full"
              />

              <div className="flex flex-col gap-6">
                <div className="flex items-start gap-1">
                  <a href={c.href} className="flex flex-1 flex-col gap-1">
                    <p className="text-32 text-ink">{c.stat}</p>
                    <p className="text-14 text-ink desk:text-16">{c.label}</p>
                  </a>
                  <a
                    href={c.href}
                    className="flex flex-1 items-center justify-end gap-1 text-14 text-ink desk:text-16"
                  >
                    Learn more
                    <ArrowTiny />
                  </a>
                </div>

                <a href={c.href} className="flex flex-col gap-4">
                  <p className="text-20 text-ink">{c.quote}</p>
                  <div className="flex flex-col">
                    <p className="text-16 text-ink">{c.name}</p>
                    <p className="text-16 text-ink">{c.role}</p>
                  </div>
                </a>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
