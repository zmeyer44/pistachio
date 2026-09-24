import { useEffect, useState } from "react";
import { ArrowDownToLine, Check, ChevronDown, Laptop, Sparkles } from "lucide-react";
import {
  BROWSER_BRANDS,
  type BrowserImportResult,
  type BrowserKind,
  type BrowserProfile,
  type InstalledBrowser,
} from "@pistachio/shell-contracts/browser-import";
import { cn } from "../../../lib/cn";
import { IMPORT_ON_THE_WEB } from "../../../lib/onboarding-steps";
import { useSurface } from "../../../surface";
import { MockWindow, StageNotice } from "../parts";
import { nativeApi } from "../../../api";

/** One profile to bring over, by browser and directory. */
export interface ProfilePick {
  browser: BrowserKind;
  profileId: string;
}

/**
 * What the person picked on the import step; the wizard runs it. Any
 * number of profiles across any of the browsers found, each bringing
 * everything its browser can hand over — there is nothing to toggle.
 */
export type ImportChoice =
  | { kind: "browser"; profiles: ProfilePick[] }
  | { kind: "fresh" };

export function samePick(a: ProfilePick, b: ProfilePick): boolean {
  return a.browser === b.browser && a.profileId === b.profileId;
}

export interface ImportStepProps {
  browsers: InstalledBrowser[] | null;
  onBrowsers: (browsers: InstalledBrowser[]) => void;
  choice: ImportChoice | null;
  onChoose: (choice: ImportChoice) => void;
  /** One per profile brought over, in the order they were imported. */
  result: BrowserImportResult[] | null;
  busy: boolean;
  error: string | null;
}

function profileLabel(profile: BrowserProfile): string {
  const account = profile.account;
  const who = account === null ? null : (account.email ?? account.displayName);
  if (who === null) return profile.name;
  return profile.name.toLowerCase() === who.toLowerCase()
    ? who
    : `${profile.name} — ${who}`;
}

/** "Signed in as Ada (ada@example.com) · 69 bookmarks", or what of that is known. */
function profileDetail(profile: BrowserProfile): string {
  const parts: string[] = [];
  const account = profile.account;
  if (account !== null) {
    const who = account.displayName ?? account.email;
    if (who !== null) {
      parts.push(
        account.displayName !== null && account.email !== null
          ? `Signed in as ${account.displayName} (${account.email})`
          : `Signed in as ${who}`,
      );
    }
  }
  if (profile.bookmarkCount !== null)
    parts.push(`${number(profile.bookmarkCount)} bookmarks`);
  return parts.length === 0 ? "Not signed in" : parts.join(" · ");
}

function number(value: number): string {
  return value.toLocaleString();
}

/**
 * The import step's stage: one card per browser found on this Mac, its
 * end tinted with the brand's colour, and under each the profiles (with
 * the accounts they are signed in to) as checkboxes, the card opening like
 * an accordion. Ticking profiles across browsers is fine. After
 * the import, the same stage reports what landed and what did not.
 */
export function ImportStep({
  browsers,
  onBrowsers,
  choice,
  onChoose,
  result,
  busy,
  error,
}: ImportStepProps) {
  const surface = useSurface();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Nothing to look for in a browser tab (W12, §14): the step shows the
    // web variant below, and `detectBrowsers` is never called at all.
    if (surface.kind === "stream" || browsers !== null) return;
    let live = true;
    void (nativeApi()?.detectBrowsers() ?? Promise.resolve([]))
      .then((found) => {
        if (live) onBrowsers(found);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [browsers, onBrowsers, surface.kind]);

  const picks = choice?.kind === "browser" ? choice.profiles : [];
  const picked = (pick: ProfilePick) =>
    picks.some((candidate) => samePick(candidate, pick));
  const setPicks = (profiles: ProfilePick[]) =>
    onChoose({ kind: "browser", profiles });

  const toggleProfile = (pick: ProfilePick) =>
    setPicks(
      picked(pick)
        ? picks.filter((candidate) => !samePick(candidate, pick))
        : [...picks, pick],
    );

  // One browser open at a time, or none. The first found starts open so
  // its profiles show at once; after that, what is open is the person's.
  const [expanded, setExpanded] = useState<BrowserKind | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (expanded === undefined && browsers !== null)
      setExpanded(browsers[0]?.kind ?? null);
  }, [browsers, expanded]);

  // The web variant (§14). It stands in FRONT of every other branch: a
  // stream surface has no browsers, no picks and no result, so there is
  // nothing below this that could be true.
  if (surface.kind === "stream") {
    return (
      <MockWindow testId="onboarding-import-web">
        <WebImport downloadUrl={surface.downloadUrl ?? null} />
      </MockWindow>
    );
  }

  if (result !== null) {
    return (
      <MockWindow testId="onboarding-import-result">
        <ImportSummary results={result} />
      </MockWindow>
    );
  }

  return (
    <MockWindow testId="onboarding-import" className="max-h-full">
      <div
        className="scroll-thin flex max-h-[calc(100vh-200px)] flex-col gap-3 overflow-y-auto px-6 pt-1 pb-6"
        role="group"
        aria-label="Profiles to bring over"
      >
        {browsers === null && !failed ? (
          <>
            <div className="h-16 animate-pulse rounded-xl bg-alpha-100" />
            <div className="h-16 animate-pulse rounded-xl bg-alpha-100" />
            <div className="h-16 animate-pulse rounded-xl bg-alpha-100" />
          </>
        ) : null}
        {failed ? (
          <StageNotice tone="warning">
            Couldn&apos;t look for browsers on this Mac. You can still start
            fresh.
          </StageNotice>
        ) : null}
        {browsers !== null && browsers.length === 0 ? (
          <StageNotice tone="info">
            No other browser was found on this Mac — nothing to bring over.
          </StageNotice>
        ) : null}
        {(browsers ?? []).map((installed) => {
          const brand = BROWSER_BRANDS[installed.kind];
          const own = picks.filter(
            (pick) => pick.browser === installed.kind,
          ).length;
          const open = expanded === installed.kind;
          const summary =
            installed.profiles.length === 1
              ? profileLabel(installed.profiles[0]!)
              : `${String(installed.profiles.length)} profiles${own > 0 ? ` · ${String(own)} selected` : ""}`;
          return (
            <div
              key={installed.kind}
              data-testid={`import-browser-${installed.kind}`}
              data-selected={own > 0 ? "" : undefined}
              data-expanded={open ? "" : undefined}
              className={cn(
                "shrink-0 overflow-hidden rounded-xl bg-background-100 transition-shadow duration-150",
                own > 0
                  ? "shadow-[0_0_0_1.5px_var(--color-gray-1000)]"
                  : "shadow-border hover:shadow-[0_0_0_1px_var(--color-gray-500)]",
              )}
            >
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`import-profiles-${installed.kind}`}
                disabled={busy}
                onClick={() => setExpanded(open ? null : installed.kind)}
                className="flex w-full cursor-pointer items-center gap-3.5 px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
              >
                <span
                  aria-hidden="true"
                  className="grid size-11 shrink-0 place-items-center rounded-[10px]"
                  style={{
                    background: `linear-gradient(135deg, ${brand.color}, color-mix(in srgb, ${brand.color} 70%, white))`,
                  }}
                >
                  <BrowserLogo kind={installed.kind} className="size-7" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label-14 font-medium text-gray-1000">
                    {brand.name}
                  </span>
                  <span className="block truncate text-label-12 text-gray-700">
                    {summary}
                  </span>
                </span>
                {own > 0 ? (
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-gray-1000 text-[10px] font-semibold text-background-100">
                    {own}
                  </span>
                ) : null}
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-gray-700 transition-transform duration-200",
                    open && "rotate-180",
                  )}
                />
              </button>
              {/* Always in the tree so it can animate: a grid row that opens
                  from 0fr to 1fr, the panel clipped inside it. */}
              <div
                id={`import-profiles-${installed.kind}`}
                role="group"
                aria-label={`${brand.name} profiles`}
                aria-hidden={!open}
                inert={!open}
                className={cn(
                  "grid transition-[grid-template-rows] duration-250 ease-[cubic-bezier(0.2,0.8,0.3,1)] motion-reduce:transition-none",
                  open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    className={cn(
                      "flex flex-col gap-0.5 border-t border-alpha-400 bg-background-200 px-2 py-2 transition-opacity duration-200 motion-reduce:transition-none",
                      open ? "opacity-100" : "opacity-0",
                    )}
                  >
                    {installed.profiles.map((profile) => {
                      const pick = {
                        browser: installed.kind,
                        profileId: profile.id,
                      };
                      const on = picked(pick);
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          data-testid={`import-profile-${installed.kind}-${profile.id}`}
                          disabled={busy}
                          onClick={() => toggleProfile(pick)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                            on
                              ? "bg-background-100 shadow-border"
                              : "hover:bg-alpha-100",
                          )}
                        >
                          <Tick on={on} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-label-13 text-gray-1000">
                              {profileLabel(profile)}
                            </span>
                            <span className="block truncate text-label-12 text-gray-700">
                              {profileDetail(profile)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                    <p className="px-2.5 pt-2 pb-0.5 text-label-12 leading-4.5 text-gray-700">
                      {installed.supports.sessions &&
                      installed.supports.bookmarks
                        ? "Signed-in sessions and bookmarks come over from each profile you tick."
                        : installed.supports.bookmarks
                          ? `Bookmarks come over. ${installed.note ?? ""}`.trim()
                          : (installed.note ??
                            "Nothing can be brought over from this browser.")}
                      {installed.supports.sessions && own > 0
                        ? ` macOS will ask whether Pistachio may read ${brand.name}'s keychain entry — that is how sessions come over. Nothing leaves this Mac.`
                        : ""}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          role="checkbox"
          aria-checked={choice?.kind === "fresh"}
          data-testid="import-fresh"
          disabled={busy}
          onClick={() => onChoose({ kind: "fresh" })}
          className={cn(
            "flex w-full shrink-0 cursor-pointer items-center gap-3.5 rounded-xl bg-background-100 px-4 py-4 text-left outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default",
            choice?.kind === "fresh"
              ? "shadow-[0_0_0_1.5px_var(--color-gray-1000)]"
              : "shadow-border hover:shadow-[0_0_0_1px_var(--color-gray-500)]",
          )}
        >
          <Tick on={choice?.kind === "fresh"} />
          <span className="min-w-0">
            <span className="block text-label-14 font-medium text-gray-1000">
              No thanks, I&apos;ll start fresh.
            </span>
            <span className="block text-label-12 text-gray-700">
              You can always sign in to things as you go.
            </span>
          </span>
          <Sparkles
            className="ml-auto size-4 shrink-0 text-gray-600"
            aria-hidden="true"
          />
        </button>
        {error !== null ? (
          <StageNotice tone="error">{error}</StageNotice>
        ) : null}
      </div>
    </MockWindow>
  );
}

/**
 * What the import step is in a browser tab: why it is a Mac's job, what a
 * Mac signed into this account brings here on its own, and where to get it.
 * No detection, no picks, no import — the step's primary simply continues.
 */
function WebImport({ downloadUrl }: { downloadUrl: string | null }) {
  return (
    <div className="flex flex-col gap-4 px-7 pb-7" data-testid="onboarding-import-web-body">
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-alpha-100 text-gray-1000"
        >
          <Laptop className="size-6" />
        </span>
        <p className="text-label-14 font-medium text-gray-1000">Bringing a browser over happens on your Mac</p>
      </div>
      <p className="text-copy-13 leading-snug text-gray-900">{IMPORT_ON_THE_WEB.reason}</p>
      <p className="text-copy-13 leading-snug text-gray-900">{IMPORT_ON_THE_WEB.sync}</p>
      {downloadUrl === null ? null : (
        <span>
          <a
            href={downloadUrl}
            // A new tab, not this one: the walkthrough is mid-flight here,
            // and navigating away from it to fetch a DMG would throw away
            // every answer the person has given so far.
            target="_blank"
            rel="noreferrer"
            data-testid="onboarding-import-download"
            className="inline-flex items-center gap-2 rounded-lg bg-gray-1000 px-3.5 py-2.5 text-label-13 font-medium text-background-100 outline-none hover:bg-gray-900 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            {IMPORT_ON_THE_WEB.download}
          </a>
        </span>
      )}
    </div>
  );
}

/** A checkbox's mark. */
function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors",
        on
          ? "border-gray-1000 bg-gray-1000 text-background-100"
          : "border-alpha-500 bg-background-100",
      )}
    >
      {on ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

/** Every profile's result added up; skipped lines name their profile when there was more than one. */
function ImportSummary({ results }: { results: BrowserImportResult[] }) {
  const first = results[0];
  if (first === undefined) return null;
  const browsers = [...new Set(results.map((item) => item.browser))];
  const from = joinNames(browsers.map((kind) => BROWSER_BRANDS[kind].name));
  const cookies = results.reduce((sum, item) => sum + item.cookies, 0);
  const bookmarks = results.reduce((sum, item) => sum + item.bookmarks, 0);
  const folders = results.reduce((sum, item) => sum + item.folders, 0);
  const origins = [...new Set(results.flatMap((item) => item.origins))].slice(
    0,
    12,
  );
  const skipped =
    results.length === 1
      ? first.skipped
      : results.flatMap((item) =>
          item.skipped.map(
            (line) =>
              `${BROWSER_BRANDS[item.browser].name} · ${item.profileId}: ${line}`,
          ),
        );
  const nothing = cookies === 0 && bookmarks === 0;
  const count =
    results.length === 1 ? "" : ` (${String(results.length)} profiles)`;
  return (
    <div className="flex flex-col gap-4 px-7 pb-7">
      <div className="flex items-center gap-3">
        <span className="flex shrink-0 gap-1.5" aria-hidden="true">
          {browsers.map((kind) => (
            <span
              key={kind}
              className="relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-xl"
              style={{
                background: `linear-gradient(135deg, ${BROWSER_BRANDS[kind].color}, color-mix(in srgb, ${BROWSER_BRANDS[kind].color} 70%, white))`,
              }}
            >
              <BrowserLogo kind={kind} className="size-7" />
            </span>
          ))}
        </span>
        <div className="min-w-0">
          <p className="text-label-14 font-medium text-gray-1000">
            {nothing
              ? `Nothing came over from ${from}`
              : `Brought over from ${from}${count}`}
          </p>
          <p className="text-label-12 text-gray-700">
            Into this Space, on this Mac.
          </p>
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-alpha-400 rounded-xl bg-background-200 shadow-border">
        <li className="flex items-start gap-3 px-4 py-3">
          <Check
            className={cn(
              "mt-0.5 size-4 shrink-0",
              cookies > 0 ? "text-green-900" : "text-gray-600",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0">
            <span className="block text-label-13 text-gray-1000">
              {cookies > 0
                ? `${number(cookies)} cookies — signed in to ${number(origins.length)}+ sites`
                : "No signed-in sessions"}
            </span>
            {origins.length > 0 ? (
              <span className="block truncate text-label-12 text-gray-700">
                {origins.join(" · ")}
              </span>
            ) : null}
          </span>
        </li>
        <li className="flex items-start gap-3 px-4 py-3">
          <Check
            className={cn(
              "mt-0.5 size-4 shrink-0",
              bookmarks > 0 ? "text-green-900" : "text-gray-600",
            )}
            aria-hidden="true"
          />
          <span className="block text-label-13 text-gray-1000">
            {bookmarks > 0
              ? `${number(bookmarks)} bookmarks as pins, in ${number(folders)} folder${folders === 1 ? "" : "s"}`
              : "No bookmarks"}
          </span>
        </li>
      </ul>
      {results.length > 1 && cookies > 0 ? (
        <p className="text-label-12 leading-4.5 text-gray-700">
          Where two profiles were signed in to the same site, the one imported
          last is the one you are signed in as now.
        </p>
      ) : null}
      {skipped.length > 0 ? <SkippedDetails lines={skipped} /> : null}
    </div>
  );
}

/**
 * What could not be brought over, folded away under one line: the count
 * is the headline, the reasons are there for whoever wants them.
 */
function SkippedDetails({ lines }: { lines: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const count = lines.length;
  return (
    <div className="flex flex-col" data-testid="import-skipped">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="import-skipped-lines"
        onClick={() => setOpen((current) => !current)}
        className="flex w-fit cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-label-12 font-medium text-gray-900 outline-none hover:bg-alpha-100 hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
        {open
          ? "Hide details"
          : `Show more · ${String(count)} ${count === 1 ? "thing" : "things"} couldn't be brought over`}
      </button>
      <div
        id="import-skipped-lines"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-250 ease-[cubic-bezier(0.2,0.8,0.3,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="flex flex-col gap-1.5 pt-2">
            {lines.map((line) => (
              <li key={line}>
                <StageNotice tone="warning">{line}</StageNotice>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** "Chrome", "Chrome and Firefox", "Chrome, Brave and Firefox". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** Chrome and Safari drawn; the others fetched, with the brand's initial behind them. */
function BrowserLogo({
  kind,
  className = "size-10",
}: {
  kind: BrowserKind;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (kind === "chrome") {
    // Google's own mark (the February 2022 icon), gradients and all.
    return (
      <svg
        viewBox="0 0 48 48"
        className={cn(className, "drop-shadow-sm")}
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="chrome-red"
            x1="3.2173"
            y1="15"
            x2="44.7812"
            y2="15"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#d93025" />
            <stop offset="1" stopColor="#ea4335" />
          </linearGradient>
          <linearGradient
            id="chrome-yellow"
            x1="20.7219"
            y1="47.6791"
            x2="41.5039"
            y2="11.6837"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#fcc934" />
            <stop offset="1" stopColor="#fbbc04" />
          </linearGradient>
          <linearGradient
            id="chrome-green"
            x1="26.5981"
            y1="46.5015"
            x2="5.8161"
            y2="10.506"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#1e8e3e" />
            <stop offset="1" stopColor="#34a853" />
          </linearGradient>
        </defs>
        <circle cx="24" cy="23.9947" r="12" fill="#fff" />
        <path
          d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z"
          fill="url(#chrome-red)"
        />
        <circle cx="24" cy="24" r="9.5" fill="#1a73e8" />
        <path
          d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z"
          fill="url(#chrome-yellow)"
        />
        <path
          d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z"
          fill="url(#chrome-green)"
        />
      </svg>
    );
  }
  if (kind === "safari") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn(className, "drop-shadow-sm")}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="11" fill="#1E90FF" />
        <circle
          cx="12"
          cy="12"
          r="9.5"
          fill="none"
          stroke="#fff"
          strokeWidth="0.8"
          strokeDasharray="0.6 1.8"
        />
        <path d="M17.5 6.5 13.6 13.6 10.4 10.4z" fill="#FF3B30" />
        <path d="M6.5 17.5 10.4 10.4 13.6 13.6z" fill="#fff" />
      </svg>
    );
  }
  const host = FAVICON_HOSTS[kind];
  if (failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center rounded-full bg-white/80 text-[15px] font-semibold text-gray-1000 drop-shadow-sm",
          className,
        )}
      >
        {BROWSER_BRANDS[kind].name.charAt(0)}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=128`}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("rounded-full drop-shadow-sm", className)}
    />
  );
}

const FAVICON_HOSTS: Record<BrowserKind, string> = {
  chrome: "google.com",
  arc: "arc.net",
  brave: "brave.com",
  edge: "microsoftedge.com",
  chromium: "chromium.org",
  vivaldi: "vivaldi.com",
  opera: "opera.com",
  firefox: "firefox.com",
  safari: "apple.com",
};
