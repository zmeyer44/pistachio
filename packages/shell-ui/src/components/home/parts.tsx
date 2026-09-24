import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { siteIconSources } from "../../lib/home";

/**
 * A site's icon at tile size: the page's own favicon once a tab has reported
 * one, else the favicon service's rendering of the host, else the site's
 * letter (lib/home.ts siteIconSources). Each source that fails to load
 * gives way to the next.
 */
export function SiteIcon({ url, faviconUrl, label, className }: { url: string; faviconUrl: string | null; label: string; className?: string }) {
  const sources = useMemo(() => siteIconSources(url, faviconUrl), [url, faviconUrl]);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [sources]);
  const src = sources[index];
  if (src === undefined) {
    return (
      <span className={cn("grid place-items-center rounded-lg bg-alpha-200 font-semibold text-gray-900", className)}>
        {(label.replace(/^www\./iu, "").charAt(0) || "•").toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" draggable={false} className={cn("object-contain", className)} onError={() => setIndex((at) => at + 1)} />;
}

/** One of the cards under the favorites: a titled panel on the page's ground. */
export function HomeCard({
  title,
  icon,
  action,
  testId,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="flex min-h-[220px] min-w-0 flex-col rounded-2xl bg-background-100 px-5 pt-4 pb-4 shadow-[0_0_0_1px_var(--color-alpha-300),0_1px_2px_var(--color-alpha-100)]"
    >
      <header className="mb-2 flex h-8 items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2.5 truncate text-[14px] font-semibold text-gray-1000">
          {icon}
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A card's quiet line when it has nothing to show yet. */
export function CardNote({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[13px] leading-snug text-gray-700">{children}</p>;
}
