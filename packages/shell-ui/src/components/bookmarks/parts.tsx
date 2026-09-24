/**
 * The small vocabulary the bookmark surfaces share: how a kind looks, how a
 * bookmark's picture falls back, how its site and first fact read. One
 * place, so the card over the page and the grid on the bookmarks page say
 * "Product · Amazon · $699.95" the same way.
 */

import { useEffect, useState } from "react";
import {
  AppWindow,
  Bookmark,
  BookOpen,
  ChefHat,
  Film,
  Globe,
  MapPin,
  Music2,
  Newspaper,
  ShoppingBag,
  Tv,
  Video,
  type LucideIcon,
} from "lucide-react";
import {
  BOOKMARK_KIND_LABEL,
  bookmarkHost,
  type Bookmark as BookmarkRecord,
  type BookmarkKind,
  type BookmarkProvenance,
} from "@pistachio/shell-contracts/bookmarks";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";

export const KIND_ICON: Record<BookmarkKind, LucideIcon> = {
  website: Globe,
  article: Newspaper,
  product: ShoppingBag,
  book: BookOpen,
  movie: Film,
  show: Tv,
  video: Video,
  music: Music2,
  recipe: ChefHat,
  place: MapPin,
  software: AppWindow,
  other: Bookmark,
};

export function KindIcon({ kind, className }: { kind: BookmarkKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={className} aria-hidden="true" />;
}

export function KindBadge({ kind, size = "sm" }: { kind: BookmarkKind; size?: "sm" | "md" }) {
  return (
    <Badge variant="gray-subtle" size={size} icon={<KindIcon kind={kind} />}>
      {BOOKMARK_KIND_LABEL[kind]}
    </Badge>
  );
}

/** "Amazon", or the host when the page named no site. */
export function siteLabel(bookmark: Pick<BookmarkRecord, "siteName" | "url">): string {
  return bookmark.siteName || bookmarkHost(bookmark.url);
}

/** Which fact a kind leads with on a card: a product its price, a recipe its time. */
const LEADING_FACT: Record<BookmarkKind, string[]> = {
  product: ["Price", "Brand", "Rating"],
  book: ["Author", "Published", "Rating"],
  movie: ["Year", "Director", "Runtime"],
  show: ["Year", "Starring", "Rating"],
  video: ["Channel", "Duration"],
  music: ["Artist", "Album"],
  recipe: ["Total time", "Cook", "Serves", "By"],
  place: ["Address", "Cuisine", "Rating"],
  software: ["Platform", "Price", "Category"],
  article: ["By", "Published", "Publisher"],
  website: [],
  other: [],
};

/** The one fact worth a card's second line: the price, the author, the cook time. */
export function primaryFact(bookmark: Pick<BookmarkRecord, "details" | "kind">): string | null {
  for (const label of LEADING_FACT[bookmark.kind]) {
    const detail = bookmark.details.find((candidate) => candidate.label === label);
    if (detail !== undefined) return detail.value;
  }
  return bookmark.details[0]?.value ?? null;
}

export const PROVENANCE_LABEL: Record<BookmarkProvenance, string> = {
  model: "Read by the model",
  page: "From the page's own tags",
  none: "Saved with the page's title",
};

/** "Aug 27" or "Aug 27, 2025" for a saved-at instant. */
export function savedOn(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

/**
 * The thing's picture, with the kind's glyph on a quiet tile when the page
 * gave none or the one it gave will not load. `cover` fills a card's frame;
 * otherwise the picture sits contained, as a book cover or poster should.
 */
export function BookmarkImage({
  bookmark,
  className,
  iconClassName,
  fit = "cover",
}: {
  bookmark: Pick<BookmarkRecord, "imageUrl" | "kind" | "title">;
  className?: string;
  iconClassName?: string;
  fit?: "cover" | "contain";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bookmark.imageUrl]);
  const src = bookmark.imageUrl;
  if (src === null || failed) {
    return (
      <span className={cn("grid place-items-center overflow-hidden bg-background-200 text-gray-600", className)} aria-hidden="true">
        <KindIcon kind={bookmark.kind} className={cn("size-6", iconClassName)} />
      </span>
    );
  }
  return (
    <span className={cn("block overflow-hidden bg-background-200", className)}>
      <img
        src={src}
        alt=""
        draggable={false}
        loading="lazy"
        className={cn("size-full", fit === "cover" ? "object-cover" : "object-contain")}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

/** A shimmering block, for a card whose page is still being read. */
export function SkeletonBlock({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("bookmark-skeleton block", className)} />;
}
