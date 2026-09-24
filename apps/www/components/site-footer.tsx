import { footerColumns, socialLinks } from "../lib/site-data";

function Column({
  title,
  links,
}: {
  title: string;
  links: readonly { label: string; href: string }[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-14 text-moss">{title}</p>
      <div className="flex flex-col gap-1">
        {links.map((l) => (
          <a key={l.label} href={l.href} className="w-fit text-14 text-cream">
            {l.label}
          </a>
        ))}
      </div>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="flex w-full flex-col items-center gap-9 bg-green px-4 py-6 desk:gap-12 desk:px-6">
      <div className="grid w-full max-w-[1464px] grid-cols-2 gap-x-6 gap-y-12 desk:grid-cols-4">
        {footerColumns.map((c) => (
          <Column key={c.title} title={c.title} links={c.links} />
        ))}
      </div>

      <div className="flex w-full max-w-[1464px] flex-col gap-6">
        {/* Oversized wordmark, drawn with the same mask technique as the logos. */}
        <span
          aria-hidden="true"
          className="brandmark w-full bg-cream"
          style={{
            aspectRatio: "106.848 / 20",
            WebkitMaskImage: "url(/logos/pistachio-wordmark.svg)",
            maskImage: "url(/logos/pistachio-wordmark.svg)",
          }}
        />

        <div className="flex flex-col items-start justify-between gap-2 desk:flex-row desk:items-center">
          <p className="text-14 text-cream">
            © 2026 Pistachio <span className="text-moss">•</span> All rights
            reserved
          </p>
          <div className="flex items-center gap-2">
            {socialLinks.map((s, i) => (
              <span key={s.label} className="flex items-center gap-2">
                {i > 0 && <span className="text-14 text-moss">•</span>}
                <a href={s.href} className="text-14 text-cream">
                  {s.label}
                </a>
              </span>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
