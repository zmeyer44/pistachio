import { leadShortcut, shortcuts } from "../lib/site-data";
import { SectionLabel } from "./primitives";

/** A keycap tile standing in for the key combination. */
function Keycap({
  keys,
  className = "",
}: {
  keys: string;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center rounded-lg bg-tile text-ink ${className}`}
    >
      <span className="font-mono text-32 desk:text-40">{keys}</span>
    </div>
  );
}

function Details({
  label,
  items,
}: {
  label: string;
  items: readonly string[];
}) {
  return (
    <div className="flex flex-col">
      <p className="text-12 text-ink">{label}</p>
      {items.map((c) => (
        <p key={c} className="text-12 text-ink">
          {c}
        </p>
      ))}
    </div>
  );
}

export function ResearchPartners() {
  return (
    <section
      id="shortcuts"
      className="shell flex flex-col gap-16 pt-2 pb-32 desk:gap-20"
    >
      <SectionLabel>Keyboard</SectionLabel>

      <div className="flex flex-col gap-20">
        <div className="flex flex-col gap-2 desk:pr-6">
          <h2 className="text-32 text-ink desk:text-40">
            Made to be driven from the keyboard
          </h2>
          <p className="text-16 text-ink desk:text-20">
            Twenty shortcuts cover tabs, pages, the window, and the agent. Every
            one can be rebound, and they keep working while your cursor is
            inside a web page.
          </p>
        </div>

        <div className="flex flex-col gap-16 desk:flex-row desk:gap-20">
          {/* lead shortcut */}
          <div className="flex flex-col gap-4 tab:flex-row tab:gap-6 desk:w-[656px] desk:shrink-0">
            <Keycap
              keys={leadShortcut.keys}
              className="aspect-square w-full tab:w-1/2 desk:size-[316px] desk:shrink-0"
            />
            <div className="flex justify-between gap-4 tab:w-1/2 tab:flex-col desk:h-[316px] desk:flex-1">
              <div className="flex flex-col">
                <p className="text-16 text-ink desk:text-20">
                  {leadShortcut.keys}
                </p>
                <p className="text-16 text-ink desk:text-20">
                  {leadShortcut.action}
                </p>
              </div>
              <Details label="Also:" items={leadShortcut.detail} />
            </div>
          </div>

          {/* the rest: a scroll rail on phones, a 3-up grid on desktop */}
          <div className="-mx-4 flex gap-6 overflow-x-auto px-4 [scrollbar-width:none] desk:mx-0 desk:grid desk:flex-1 desk:grid-cols-3 desk:overflow-visible desk:px-0">
            {shortcuts.map((s) => (
              <div
                key={s.keys}
                className="flex w-[140px] shrink-0 flex-col gap-2 desk:w-auto"
              >
                <Keycap
                  keys={s.keys}
                  className="aspect-square w-full desk:aspect-[203/200]"
                />
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col">
                    <p className="text-12 text-ink">{s.action}</p>
                  </div>
                  <Details label="Note" items={s.detail} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
