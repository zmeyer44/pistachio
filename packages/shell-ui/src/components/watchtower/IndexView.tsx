/**
 * The index: what the saved pages are ABOUT. A page is a document; the
 * people, companies, products and ideas it names persist across sites, so
 * the index lists them once each — "Stripe" read on stripe.com, in a news
 * story and in a transcript is one company with three sources.
 *
 * Built from the page's own pieces: the list is a list of rows like the
 * timeline's, and an entry opens in the same reader pane a saved page does,
 * with the same header, notes and link lists.
 */

import { ArrowLeft, BookOpen, Building2, CalendarDays, CircleHelp, Cpu, FolderGit2, Landmark, Lightbulb, MapPin, Package, Search, Trash2, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  WATCHTOWER_ENTITY_KINDS,
  WATCHTOWER_ENTITY_LABELS,
  WATCHTOWER_FACT_KINDS,
  WATCHTOWER_FACT_LABELS,
  type WatchtowerEntity,
  type WatchtowerEntityDocument,
  type WatchtowerEntityKind,
  type WatchtowerEntityRef,
  type WatchtowerIndex,
} from "@pistachio/shell-contracts/watchtower";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Note } from "../ui/note";
import { Select } from "../ui/select";
import { formatDay, formatMoment, hostOfUrl } from "./format";

export const KIND_ICON: Record<WatchtowerEntityKind, LucideIcon> = {
  person: User,
  company: Building2,
  organization: Landmark,
  product: Package,
  technology: Cpu,
  place: MapPin,
  event: CalendarDays,
  work: BookOpen,
  project: FolderGit2,
  concept: Lightbulb,
  question: CircleHelp,
};

const plural = (n: number, noun: string): string => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

/** "117 companies · 64 people · 23 technologies": what browsing turned into, largest first. */
export function indexSummary(counts: WatchtowerIndex["counts"], max = 4): string {
  const parts = WATCHTOWER_ENTITY_KINDS.flatMap((kind) => {
    const n = counts[kind] ?? 0;
    return n === 0 ? [] : [{ n, text: `${n.toLocaleString()} ${(n === 1 ? WATCHTOWER_ENTITY_LABELS[kind].one : WATCHTOWER_ENTITY_LABELS[kind].many).toLowerCase()}` }];
  }).sort((a, b) => b.n - a.n);
  const shown = parts.slice(0, max).map((part) => part.text);
  if (parts.length > max) shown.push(`${String(parts.length - max)} more ${parts.length - max === 1 ? "kind" : "kinds"}`);
  return shown.join(" · ");
}

export function KindIcon({ kind, className }: { kind: WatchtowerEntityKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden="true" />;
}

/* ---------------------------------- list ---------------------------------- */

export function EntityRow({ entity, selected, onSelect }: { entity: WatchtowerEntity; selected: boolean; onSelect(): void }) {
  const others = entity.aliases.slice(1, 3);
  return (
    <li data-testid="watchtower-entity" data-kind={entity.kind}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full cursor-pointer items-center gap-3 border-b border-alpha-200 px-5 py-3 text-left outline-none transition-colors focus-visible:bg-gray-100 @max-md:px-3",
          selected ? "bg-gray-100" : "hover:bg-alpha-100",
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background-200 text-gray-900 shadow-border">
          <KindIcon kind={entity.kind} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-label-14 font-medium text-gray-1000">{entity.name}</span>
            {others.length === 0 ? null : <span className="min-w-0 truncate text-label-12 text-gray-700">also {others.join(", ")}</span>}
          </span>
          <span className="flex items-center gap-2 text-label-12 text-gray-700">
            <span>{WATCHTOWER_ENTITY_LABELS[entity.kind].one}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              {plural(entity.pageCount, "page")}
              {entity.siteCount > 1 ? ` on ${plural(entity.siteCount, "site")}` : ""}
            </span>
            {entity.factCount === 0 ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{plural(entity.factCount, "fact")}</span>
              </>
            )}
          </span>
        </span>
        {entity.lastSeen > 0 ? <time className="shrink-0 text-label-12 text-gray-700">{formatDay(entity.lastSeen)}</time> : null}
      </button>
    </li>
  );
}

/** Kinds as filters, each with how many there are; kinds with none are left out. */
export function KindPills({
  counts,
  kind,
  onChange,
  Pill,
}: {
  counts: WatchtowerIndex["counts"];
  kind: WatchtowerEntityKind | null;
  onChange(kind: WatchtowerEntityKind | null): void;
  Pill: (props: { active: boolean; label: string; onClick(): void }) => React.ReactNode;
}) {
  const total = WATCHTOWER_ENTITY_KINDS.reduce((n, item) => n + (counts[item] ?? 0), 0);
  return (
    <div role="tablist" aria-label="Filter by kind" className="flex flex-wrap items-center gap-1">
      <Pill active={kind === null} label={total === 0 ? "All" : `All ${total.toLocaleString()}`} onClick={() => onChange(null)} />
      {WATCHTOWER_ENTITY_KINDS.filter((item) => (counts[item] ?? 0) > 0 || item === kind).map((item) => (
        <Pill key={item} active={kind === item} label={`${WATCHTOWER_ENTITY_LABELS[item].many} ${(counts[item] ?? 0).toLocaleString()}`} onClick={() => onChange(item)} />
      ))}
    </div>
  );
}

/* ---------------------------------- chips ---------------------------------- */

/** Entries as small buttons: what a page is about, or what an entry is named with. */
export function EntityChips({ entities, onOpen, label }: { entities: WatchtowerEntityRef[]; onOpen(id: number): void; label: string }) {
  if (entities.length === 0) return null;
  return (
    <section aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-label-12 text-gray-700">{label}</span>
      {entities.map((entity) => (
        <button
          key={entity.id}
          type="button"
          title={WATCHTOWER_ENTITY_LABELS[entity.kind].one}
          onClick={() => onOpen(entity.id)}
          data-testid="watchtower-entity-chip"
          className="flex h-6 max-w-60 cursor-pointer items-center gap-1.5 rounded-full bg-background-100 px-2.5 text-label-12 text-gray-1000 shadow-border outline-none transition-colors hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <KindIcon kind={entity.kind} className="size-3 text-gray-700" />
          <span className="truncate">{entity.name}</span>
        </button>
      ))}
    </section>
  );
}

/* --------------------------------- reader ---------------------------------- */

const KIND_ITEMS = WATCHTOWER_ENTITY_KINDS.map((kind) => ({ value: kind, label: WATCHTOWER_ENTITY_LABELS[kind].one }));

export function EntityReader({
  entity,
  busy,
  onBack,
  onOpenPage,
  onOpenEntity,
  onSearch,
  onEdit,
}: {
  entity: WatchtowerEntityDocument;
  busy: boolean;
  onBack(): void;
  onOpenPage(observationId: string): void;
  onOpenEntity(id: number): void;
  onSearch(name: string): void;
  onEdit(edit: { merge?: number; kind?: WatchtowerEntityKind; remove?: boolean }): void;
}) {
  const others = entity.aliases.slice(1);
  const groups = WATCHTOWER_FACT_KINDS.map((kind) => ({ kind, facts: entity.facts.filter((fact) => fact.kind === kind) })).filter((group) => group.facts.length > 0);
  return (
    <article className="mx-auto flex w-full max-w-180 flex-col gap-5 px-8 pt-5 pb-16 @max-md:px-4" data-testid="watchtower-entity-reader">
      <div className="flex items-center gap-2">
        <Button variant="tertiary" size="sm" svgOnly aria-label="Back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="flex items-center gap-1.5 text-label-12 text-gray-700">
          <KindIcon kind={entity.kind} />
          {WATCHTOWER_ENTITY_LABELS[entity.kind].one}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" prefix={<Search aria-hidden="true" />} onClick={() => onSearch(entity.name)}>
            Search saved pages
          </Button>
        </div>
      </div>

      <header className="flex flex-col gap-2">
        <h2 className="text-heading-24 text-gray-1000">{entity.name}</h2>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-13 text-gray-900">
          <span>
            Named on {plural(entity.pageCount, "saved page")}
            {entity.siteCount > 1 ? ` across ${plural(entity.siteCount, "site")}` : ""}
          </span>
          {entity.firstSeen > 0 ? (
            <>
              <span aria-hidden="true" className="text-gray-600">
                ·
              </span>
              <span>
                {formatDay(entity.firstSeen) === formatDay(entity.lastSeen) ? formatDay(entity.lastSeen) : `${formatDay(entity.firstSeen)} – ${formatDay(entity.lastSeen)}`}
              </span>
            </>
          ) : null}
        </p>
        {others.length === 0 ? null : <p className="text-copy-13 text-gray-900">Also written {others.map((alias) => `“${alias}”`).join(", ")}</p>}
      </header>

      {entity.similar.length === 0 ? null : (
        <div className="flex flex-col gap-2 rounded-md bg-background-200 px-3.5 py-3 shadow-border" data-testid="watchtower-similar">
          <p className="text-label-13 text-gray-1000">Possibly the same as</p>
          <ul className="flex flex-col gap-1.5">
            {entity.similar.map((other) => (
              <li key={other.id} className="flex items-center gap-2">
                <button type="button" onClick={() => onOpenEntity(other.id)} className="min-w-0 cursor-pointer truncate text-left text-label-13 text-gray-1000 underline decoration-gray-500 underline-offset-2 outline-none hover:decoration-gray-1000 focus-visible:ring-2 focus-visible:ring-ring">
                  {other.name}
                </button>
                <Button size="xs" variant="secondary" disabled={busy} className="ml-auto" onClick={() => onEdit({ merge: other.id })}>
                  Merge into {other.name.length > 24 ? "it" : other.name}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-label-12 text-gray-700">Merging moves this entry’s pages, facts and spellings into the other. Saved pages are not changed.</p>
        </div>
      )}

      {groups.length === 0 ? null : (
        <section aria-label="Facts" className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.kind} className="flex flex-col gap-2.5">
              <h3 className="text-label-12 font-medium text-gray-700">{WATCHTOWER_FACT_LABELS[group.kind]}</h3>
              <ul className="flex flex-col gap-3">
                {group.facts.map((fact) => (
                  <li key={`${fact.source.observationId}:${fact.text}`} className="flex flex-col gap-1">
                    <blockquote className="border-l-2 border-gray-400 pl-3.5 text-copy-14 text-gray-1000">{fact.text}</blockquote>
                    <button
                      type="button"
                      onClick={() => onOpenPage(fact.source.observationId)}
                      className="ml-4 flex min-w-0 cursor-pointer items-center gap-1.5 self-start text-left text-label-12 text-gray-700 outline-none hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate">{fact.source.title || hostOfUrl(fact.source.url)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0 font-mono">{hostOfUrl(fact.source.url)}</span>
                      <span aria-hidden="true">·</span>
                      <time className="shrink-0">{formatDay(fact.source.visitedAt)}</time>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <section aria-label="Saved pages that name it" className="flex flex-col gap-2">
        <h3 className="text-label-12 font-medium text-gray-700">Saved pages that name it</h3>
        <ul className="divide-y divide-alpha-200 rounded-md shadow-border">
          {entity.mentions.map((mention) => (
            <li key={mention.source.observationId}>
              <button type="button" onClick={() => onOpenPage(mention.source.observationId)} className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left outline-none hover:bg-alpha-100 focus-visible:bg-gray-100">
                <span className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-label-13 text-gray-1000">{mention.source.title || hostOfUrl(mention.source.url)}</span>
                  <time className="shrink-0 text-label-12 text-gray-700">{formatMoment(mention.source.visitedAt)}</time>
                </span>
                {mention.context === "" ? null : <span className="line-clamp-2 text-copy-13 text-gray-900">{mention.context}</span>}
                <span className="truncate font-mono text-label-12 text-gray-700">{hostOfUrl(mention.source.url)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <EntityChips label="Named with" entities={entity.related} onOpen={onOpenEntity} />

      {entity.sites.length < 2 ? null : (
        <p className="text-label-12 text-gray-700">
          On {entity.sites.map((site) => `${site.host.replace(/^www\./u, "")} (${String(site.pages)})`).join(", ")}
        </p>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-2 border-t border-alpha-400 pt-4">
        <span className="text-label-13 text-gray-900">Kind</span>
        <Select aria-label="Kind" value={entity.kind} items={KIND_ITEMS} disabled={busy} onValueChange={(kind) => onEdit({ kind })} className="w-40" />
        <Button size="sm" variant="tertiary" className="ml-auto" disabled={busy} prefix={<Trash2 aria-hidden="true" />} onClick={() => onEdit({ remove: true })}>
          Remove from index
        </Button>
      </footer>
      <p className="-mt-3 text-label-12 text-gray-700">Removing keeps this name out of the index. The saved pages that name it stay saved and searchable.</p>
    </article>
  );
}

/** Why the index is empty, or how far along it is. */
export function IndexNote({ smartIndex, pending, busy, onEnable }: { smartIndex: boolean; pending: number; busy: boolean; onEnable(): void }) {
  if (!smartIndex)
    return (
      <Note
        type="secondary"
        size="sm"
        action={
          <Button size="xs" variant="secondary" loading={busy} onClick={onEnable}>
            Turn on
          </Button>
        }
        data-testid="watchtower-index-off"
      >
        Only what pages declare about themselves is indexed. To find the people, companies and ideas in their text, names and the sentence around each go to the Jev decision model through your Pistachio account.
      </Note>
    );
  if (pending === 0) return null;
  return (
    <Note type="secondary" size="sm" data-testid="watchtower-index-pending">
      Reading names on {plural(pending, "saved page")}. New entries appear as they are found.
    </Note>
  );
}
