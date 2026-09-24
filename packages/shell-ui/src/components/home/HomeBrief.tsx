import { useEffect } from "react";
import { ArrowRight, Newspaper } from "lucide-react";
import { localDayOf } from "../../lib/reports";
import { useAppStore } from "../../store";
import { briefKey, useBriefStore } from "../reports/use-brief";

/**
 * The way into the daily brief from the home page: one quiet line under the
 * greeting. Once today's brief exists it carries the brief's own headline, so
 * the page already says the shape of the day; before that it is an invitation.
 * A host with no reports (a cloud session) shows nothing.
 */
export function HomeBrief({ now }: { now: Date }) {
  const spaceId = useAppStore((s) => s.snapshot?.activeSpaceId ?? null);
  const openBrief = useAppStore((s) => s.openBrief);
  const today = localDayOf(now);
  const report = useBriefStore((s) => (spaceId === null ? null : (s.entries[briefKey(spaceId, today)]?.response.report ?? null)));
  const unsupported = useBriefStore((s) => s.unsupported);

  useEffect(() => {
    if (spaceId !== null) void useBriefStore.getState().load(spaceId, today);
  }, [spaceId, today]);

  if (unsupported || spaceId === null) return null;
  const headline = ((report?.spec.state ?? {}) as { text?: { headline?: unknown } }).text?.headline;
  return (
    <button
      type="button"
      data-testid="home-brief"
      onClick={openBrief}
      className="group mt-4 flex max-w-full cursor-pointer items-center gap-2 rounded-full bg-alpha-100 py-1.5 pr-3 pl-2.5 text-[13px] text-gray-900 transition-colors hover:bg-alpha-200 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none @3xl:mt-5"
    >
      <Newspaper className="size-3.5 shrink-0 text-gray-700" strokeWidth={1.75} aria-hidden="true" />
      <span className="shrink-0 font-medium text-gray-1000">{report?.title ?? "Daily Brief"}</span>
      <span className="truncate">{typeof headline === "string" && headline !== "" ? headline : "See what today holds"}</span>
      <ArrowRight className="size-3.5 shrink-0 text-gray-700 transition-transform group-hover:translate-x-0.5" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
