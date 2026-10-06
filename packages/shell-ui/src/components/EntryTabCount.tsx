import { cn } from "../lib/cn";

/** How many tabs wait on a favorite's or pin's desk besides its page (its page's group, TabGroupInfo.anchorId). */
export function EntryTabCount({ count, testId, className }: { count: number; testId: string; className?: string }) {
  return (
    <span
      data-testid={testId}
      aria-label={`${count} more ${count === 1 ? "tab" : "tabs"} on its desk`}
      title={`${count} more ${count === 1 ? "tab" : "tabs"} on its desk`}
      className={cn("grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-alpha-200 px-1 text-[10px] leading-none font-medium text-gray-900 tabular-nums", className)}
    >
      {count}
    </span>
  );
}
