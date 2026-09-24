import type { ReactNode } from "react";

/**
 * The reading layout shared by the docs and privacy pages: a left column
 * of section links that stays put on desktop, and the sections themselves,
 * each addressable by id so site-wide `/docs#section` links land on it.
 */

export interface ProseSection {
  id: string;
  title: string;
}

export function ProseLayout({
  sections,
  children,
}: {
  sections: readonly ProseSection[];
  children: ReactNode;
}) {
  return (
    <div className="grid gap-12 desk:grid-cols-[220px_minmax(0,1fr)] desk:gap-16">
      <nav aria-label="On this page" className="desk:sticky desk:top-28 desk:self-start">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 desk:flex-col desk:gap-y-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-14 text-ink hover:text-green hover:underline">
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex max-w-[720px] flex-col gap-14">{children}</div>
    </div>
  );
}

export function Prose({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-28 flex-col gap-4">
      <h2 className="text-24 text-ink tab:text-28">{title}</h2>
      <div className="flex flex-col gap-3 text-16 text-ink [&_a]:underline [&_a:hover]:text-green [&_code]:rounded [&_code]:bg-tile [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-14 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
