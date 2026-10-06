/**
 * Settings → Privacy & security → Ads & trackers (docs/shields.md): the
 * protection level, every protection it sets, the filter lists, the
 * person's own filters, and the sites Shields are down on.
 *
 * A level owns its knobs the way Firefox's Enhanced Tracking Protection
 * does: choosing Standard or Strict sets every protection below, and
 * changing any one of them makes the choice Custom. The page computes the
 * whole result (`mergeShieldsPatch`) and sends it, so what it shows at once
 * is what main will store.
 *
 * The settings are `DesktopSettings.shields`; the engine, the lists, the
 * exceptions, and the counts come from `shellApi().shields`, which a host
 * that blocks nothing (a cloud session) refuses — the page then says so.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, ShieldPlus, Shield, SlidersHorizontal, X } from "lucide-react";
import {
  COOKIE_NOTICE_LISTS,
  FILTER_LIST_CATEGORIES,
  FILTER_LISTS,
  MAX_CUSTOM_FILTERS,
  mergeShieldsPatch,
  URL_TRACKING_LISTS,
  type FilterListDefinition,
  type FilterListStatus,
  type ShieldsLevel,
  type ShieldsSettings,
  type ShieldsStatus,
} from "@pistachio/shell-contracts/shields";
import { shellApi } from "../../../api";
import { cn } from "../../../lib/cn";
import { relativeTime } from "../../../lib/home";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Note } from "../../ui/note";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { Block, Group, Page, Row, probe, useUnavailable } from "../parts";

const TITLE = "Ads & trackers";
const DESCRIPTION =
  "Pistachio blocks ads, trackers, and dangerous sites itself, with the community filter lists uBlock Origin and Brave use, and keeps sites from following you from one to the next. If a page stops working, turn Shields down for that site from its site menu.";

const LEVELS: { id: ShieldsLevel; label: string; icon: typeof Shield; summary: string }[] = [
  {
    id: "standard",
    label: "Standard",
    icon: ShieldCheck,
    summary: "Ads, trackers, and dangerous sites blocked without breaking pages. Requests to the site you are on are let through.",
  },
  {
    id: "strict",
    label: "Strict",
    icon: ShieldPlus,
    summary: "Also blocks the site's own trackers, cookie banners, annoyances, and every cross-site cookie, and asks before HTTP. Some sites may break.",
  },
  {
    id: "custom",
    label: "Custom",
    icon: SlidersHorizontal,
    summary: "Choose each protection yourself.",
  },
];

const BLOCKING = [
  { value: "off", label: "Off" },
  { value: "standard", label: "Standard" },
  { value: "aggressive", label: "Aggressive" },
] as const;
const COOKIE_BANNERS = [
  { value: "off", label: "Leave them" },
  { value: "hide", label: "Hide them" },
] as const;
const TRACKING_PARAMS = [
  { value: "off", label: "Keep them" },
  { value: "standard", label: "Remove trackers" },
  { value: "strict", label: "Remove trackers and campaign tags" },
] as const;
const CROSS_SITE_COOKIES = [
  { value: "allow", label: "Allow" },
  { value: "trackers", label: "Block tracking cookies" },
  { value: "all", label: "Block all" },
] as const;
const REFERRER = [
  { value: "default", label: "Browser default" },
  { value: "trim", label: "Only the site" },
  { value: "strip", label: "Don't send" },
] as const;
const FINGERPRINTING = [
  { value: "off", label: "Off" },
  { value: "standard", label: "Standard" },
  { value: "strict", label: "Strict" },
] as const;
const HTTPS = [
  { value: "off", label: "Off" },
  { value: "upgrade", label: "Upgrade when possible" },
  { value: "strict", label: "HTTPS only" },
] as const;
const WEBRTC = [
  { value: "default", label: "Default" },
  { value: "public", label: "Public address only" },
  { value: "proxied", label: "Through a proxy only" },
] as const;

/** How often an open page asks again: soon while lists are moving, rarely otherwise. */
const BUSY_POLL_MS = 1_500;
const IDLE_POLL_MS = 30_000;

function count(value: number): string {
  return value.toLocaleString();
}

export function ShieldsPage() {
  const shields = useAppStore((state) => state.settings.shields);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const unavailable = useUnavailable("shields");
  const [status, setStatus] = useState<ShieldsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async (request: Parameters<ReturnType<typeof shellApi>["shields"]>[0] = { type: "status" }) => {
    try {
      setStatus(await probe("shields", () => shellApi().shields(request)));
      setError(null);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const busy = status !== null && (status.updating || status.engine.state === "compiling" || status.engine.state === "loading");
  useEffect(() => {
    void ask();
  }, [ask, shields]);
  useEffect(() => {
    const timer = window.setInterval(() => void ask(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [ask, busy]);

  const apply = (patch: Partial<ShieldsSettings>) => void updateSettings({ shields: mergeShieldsPatch(shields, patch) });

  if (unavailable !== null) {
    return (
      <Page title={TITLE} description={DESCRIPTION}>
        <Group>
          <Row label="Not available here" note={unavailable} />
        </Group>
      </Page>
    );
  }

  const off = !shields.enabled;
  const stats = status?.stats;

  return (
    <Page title={TITLE} description={DESCRIPTION}>
      <Group
        footer={
          stats === undefined
            ? undefined
            : `${count(stats.blocked)} requests blocked · ${count(stats.cleaned)} addresses cleaned · ${count(stats.upgraded)} pages moved to HTTPS since ${new Date(stats.since).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
        }
        footerAction={
          <Button variant="secondary" size="sm" disabled={stats === undefined || stats.blocked + stats.cleaned + stats.upgraded === 0} onClick={() => void ask({ type: "resetStats" })}>
            Reset counts
          </Button>
        }
      >
        <Row label="Shields" note="Off, no page is filtered, no list is fetched, and every protection below stands down.">
          <span data-testid="shields-enabled">
            <Switch checked={shields.enabled} label="Shields" onChange={(enabled) => apply({ enabled })} />
          </span>
        </Row>
        <EngineNote status={status} error={error} enabled={shields.enabled} />
      </Group>

      <Group title="Protection level" note="A level sets every protection on this page. Change any one of them and the level becomes Custom.">
        <Block>
          <div role="radiogroup" aria-label="Protection level" className="grid grid-cols-3 gap-2 @max-md:grid-cols-1">
            {LEVELS.map(({ id, label, icon: Icon, summary }) => {
              const selected = shields.level === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={off}
                  data-testid={`shields-level-${id}`}
                  onClick={() => apply({ level: id })}
                  className={cn(
                    "flex cursor-pointer flex-col items-start gap-1.5 rounded-md p-3 text-left outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
                    selected
                      ? "bg-background-100 shadow-[0_0_0_2px_var(--color-gray-1000)]"
                      : "bg-background-100 shadow-border hover:shadow-[0_0_0_1px_var(--color-gray-500)]",
                  )}
                >
                  <span className="flex items-center gap-2 text-label-14 text-gray-1000">
                    <Icon className="size-4" aria-hidden="true" />
                    {label}
                  </span>
                  <span className="text-copy-13 leading-4.5 text-gray-900">{summary}</span>
                </button>
              );
            })}
          </div>
        </Block>
      </Group>

      <Group title="Blocking" note="What filter lists keep out of pages.">
        <Row
          label="Ads and trackers"
          note="Standard lets requests to the site you are on through unless a filter insists, which is where most breakage comes from. Aggressive applies every filter as written."
        >
          <Select aria-label="Ads and trackers" value={shields.blocking} items={BLOCKING} disabled={off} onValueChange={(blocking) => apply({ blocking })} />
        </Row>
        <Row label="Cookie banners" note="Hide consent pop-ups with the cookie-notice lists. Hiding one consents to nothing: the site sees no answer.">
          <Select aria-label="Cookie banners" value={shields.cookieBanners} items={COOKIE_BANNERS} disabled={off} onValueChange={(cookieBanners) => apply({ cookieBanners })} />
        </Row>
        <Row label="Dangerous sites" note="Stop a page on a Security list before it loads, with a warning you can click through.">
          <Switch checked={shields.dangerousSites} label="Dangerous sites" disabled={off} onChange={(dangerousSites) => apply({ dangerousSites })} />
        </Row>
      </Group>

      <Group title="Tracking" note="How sites follow you from one to the next, and what Shields does about each.">
        <Row label="Tracking parameters" note="Click identifiers in links (fbclid, gclid, msclkid, …), removed before the page loads. Campaign tags (utm_…) only tell a site where you came from.">
          <Select aria-label="Tracking parameters" value={shields.trackingParams} items={TRACKING_PARAMS} disabled={off} onValueChange={(trackingParams) => apply({ trackingParams })} />
        </Row>
        <Row label="Bounce tracking" note="Skip the redirect pages that exist only to record a click on the way out (google.com/url, l.facebook.com, and others).">
          <Switch checked={shields.bounceTracking} label="Bounce tracking" disabled={off} onChange={(bounceTracking) => apply({ bounceTracking })} />
        </Row>
        <Row label="Cross-site cookies" note="Cookies sent to other sites than the one you are on. Blocking all of them can sign you out of embedded logins and comment boxes.">
          <Select aria-label="Cross-site cookies" value={shields.crossSiteCookies} items={CROSS_SITE_COOKIES} disabled={off} onValueChange={(crossSiteCookies) => apply({ crossSiteCookies })} />
        </Row>
        <Row label="Referrer" note="What another site is told about the page that sent you. Only the site holds every page to Chromium's default, even when the page asks for more.">
          <Select aria-label="Referrer" value={shields.referrer} items={REFERRER} disabled={off} onValueChange={(referrer) => apply({ referrer })} />
        </Row>
        <Row label="Global Privacy Control" note="Tell every site not to sell or share your data (Sec-GPC). Several US states make it binding. Sent even where Shields are down; Do Not Track is not sent, as it is retired and only adds to your fingerprint.">
          <Switch checked={shields.globalPrivacyControl} label="Global Privacy Control" disabled={off} onChange={(globalPrivacyControl) => apply({ globalPrivacyControl })} />
        </Row>
        <Row label="Hyperlink auditing" note="Block the ping a page can send when you click a link, reporting where you went.">
          <Switch checked={shields.blockPings} label="Hyperlink auditing" disabled={off} onChange={(blockPings) => apply({ blockPings })} />
        </Row>
      </Group>

      <Group title="Fingerprinting and connections">
        <Row
          label="Fingerprinting"
          note="Standard adds per-site noise to what canvas, WebGL, and audio read back, as Brave does. Strict also hides your graphics card, battery, network, voices, and screen size."
        >
          <Select aria-label="Fingerprinting" value={shields.fingerprinting} items={FINGERPRINTING} disabled={off} onValueChange={(fingerprinting) => apply({ fingerprinting })} />
        </Row>
        <Row label="HTTPS" note="Load http:// pages over HTTPS. Upgrade falls back quietly when a site has no HTTPS; HTTPS only warns you first.">
          <Select aria-label="HTTPS" value={shields.https} items={HTTPS} disabled={off} onValueChange={(https) => apply({ https })} />
        </Row>
        <Row label="WebRTC" note="Which network routes calls and peer-to-peer connections may use. Through a proxy only can break calls on sites without a relay server.">
          <Select aria-label="WebRTC" value={shields.webRtc} items={WEBRTC} disabled={off} onValueChange={(webRtc) => apply({ webRtc })} />
        </Row>
      </Group>

      <FilterLists shields={shields} status={status} disabled={off || shields.blocking === "off"} apply={apply} onUpdate={() => void ask({ type: "updateLists" })} />

      <CustomFilters shields={shields} status={status} disabled={off} apply={apply} />

      <SiteExceptions status={status} ask={ask} />
    </Page>
  );
}

function EngineNote({ status, error, enabled }: { status: ShieldsStatus | null; error: string | null; enabled: boolean }) {
  if (error !== null) {
    return (
      <Block>
        <Note type="error" size="sm">
          {error}
        </Note>
      </Block>
    );
  }
  if (!enabled || status === null) return null;
  const { engine } = status;
  if (engine.state === "failed") {
    return (
      <Block>
        <Note type="error" size="sm">
          The filters could not be built{engine.error === null ? "." : `: ${engine.error}`}
        </Note>
      </Block>
    );
  }
  if (engine.state === "compiling" || status.updating || (engine.state === "loading" && engine.networkFilters === 0)) {
    return (
      <Block>
        <Note type="info" size="sm" data-testid="shields-engine-busy">
          {status.updating ? "Fetching filter lists…" : engine.state === "compiling" ? "Building the filters…" : "Waiting for the first filter lists."}
        </Note>
      </Block>
    );
  }
  return null;
}

function listNote(definition: FilterListDefinition, status: FilterListStatus | undefined, forcedBy: string | null): string {
  const parts: string[] = [definition.description];
  if (forcedBy !== null) parts.push(`On while ${forcedBy}.`);
  if (status === undefined) return parts.join(" ");
  if (status.state === "fetching") parts.push("Updating…");
  else if (status.state === "failed") parts.push(`Last fetch failed: ${status.error ?? "unknown error"}.`);
  else if (status.fetchedAt !== null) parts.push(`Updated ${relativeTime(status.fetchedAt, Date.now()).toLowerCase()} · ${count(status.rules)} ${status.rules === 1 ? "rule" : "rules"}.`);
  else if (status.enabled) parts.push("Not downloaded yet.");
  return parts.join(" ");
}

function FilterLists({
  shields,
  status,
  disabled,
  apply,
  onUpdate,
}: {
  shields: ShieldsSettings;
  status: ShieldsStatus | null;
  disabled: boolean;
  apply(patch: Partial<ShieldsSettings>): void;
  onUpdate(): void;
}) {
  const byId = new Map((status?.lists ?? []).map((list) => [list.id, list]));
  const forcedBy = (id: FilterListDefinition["id"]): string | null => {
    if (shields.cookieBanners === "hide" && COOKIE_NOTICE_LISTS.includes(id)) return "cookie banners are hidden";
    if (shields.trackingParams === "strict" && URL_TRACKING_LISTS.includes(id)) return "campaign tags are removed";
    return null;
  };
  const checked = status?.lastCheckedAt ?? null;
  return (
    <Group
      title="Filter lists"
      note="Fetched from their maintainers, never bundled, and fetched again when each says it is stale. More lists block more, and take longer to load."
      footer={checked === null ? "Not checked yet this session." : `Checked ${relativeTime(checked, Date.now()).toLowerCase()}.`}
      footerAction={
        <Button
          variant="secondary"
          size="sm"
          prefix={<RefreshCw aria-hidden="true" className={cn(status?.updating === true && "animate-spin")} />}
          disabled={disabled || status === null || status.updating}
          onClick={onUpdate}
          data-testid="shields-update-lists"
        >
          {status?.updating === true ? "Updating…" : "Update now"}
        </Button>
      }
    >
      {FILTER_LIST_CATEGORIES.map((category) => (
        <div key={category.id}>
          <p className="px-5 pt-3.5 pb-0 text-label-12 font-medium tracking-wide text-gray-800 uppercase @max-md:px-4">{category.label}</p>
          {(FILTER_LISTS as readonly FilterListDefinition[])
            .filter((list) => list.category === category.id)
            .map((list) => {
              const forced = forcedBy(list.id);
              return (
                <Row key={list.id} label={list.name} note={listNote(list, byId.get(list.id), forced)}>
                  <Switch
                    checked={forced !== null || shields.lists[list.id]}
                    disabled={disabled || forced !== null}
                    label={list.name}
                    onChange={(on) => apply({ lists: { ...shields.lists, [list.id]: on } })}
                  />
                </Row>
              );
            })}
        </div>
      ))}
    </Group>
  );
}

function CustomFilters({
  shields,
  status,
  disabled,
  apply,
}: {
  shields: ShieldsSettings;
  status: ShieldsStatus | null;
  disabled: boolean;
  apply(patch: Partial<ShieldsSettings>): void;
}) {
  const [draft, setDraft] = useState(shields.customFilters);
  useEffect(() => setDraft(shields.customFilters), [shields.customFilters]);
  const dirty = draft !== shields.customFilters;
  const errors = status?.engine.customErrors ?? [];
  return (
    <Group
      title="My filters"
      note="Your own rules, in uBlock Origin's syntax, applied on top of the lists. They do not change with the level."
      footer={
        <>
          <code className="font-mono">||ads.example.com^</code> blocks a server; <code className="font-mono">example.com##.banner</code> hides an element;{" "}
          <code className="font-mono">@@||example.com^</code> lets one through.
        </>
      }
      footerAction={
        <Button size="sm" disabled={disabled || !dirty || draft.length > MAX_CUSTOM_FILTERS} onClick={() => apply({ customFilters: draft })} data-testid="shields-custom-apply">
          Apply
        </Button>
      }
    >
      <Block>
        <Textarea
          aria-label="My filters"
          data-testid="shields-custom-filters"
          value={draft}
          disabled={disabled}
          spellCheck={false}
          placeholder={"||tracker.example.com^\nnews.example.com##.newsletter-popup"}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-32 font-mono text-[12.5px] leading-5"
        />
        {errors.length > 0 ? (
          <Note type="warning" size="sm" className="mt-3">
            {errors.length === 1 ? "One line was not understood and is ignored: " : `${String(errors.length)} lines were not understood and are ignored: `}
            <code className="font-mono">{errors.slice(0, 3).join("  ·  ")}</code>
          </Note>
        ) : null}
      </Block>
    </Group>
  );
}

function SiteExceptions({ status, ask }: { status: ShieldsStatus | null; ask(request: { type: "setSite"; site: string; enabled: boolean }): Promise<void> }) {
  const [site, setSite] = useState("");
  const exceptions = status?.exceptions ?? [];
  const add = () => {
    const value = site.trim();
    if (value === "") return;
    void ask({ type: "setSite", site: value, enabled: false }).then(() => setSite(""));
  };
  return (
    <Group
      title="Sites with Shields down"
      note="Nothing is blocked, cleaned, or randomized on these sites or their subdomains. The site menu's Shields switch adds and removes them too."
    >
      {exceptions.length === 0 ? <Row label="None" note="Shields are up everywhere." /> : null}
      {exceptions.map((exception) => (
        <Row key={exception.key} label={exception.key} note={`Since ${new Date(exception.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}>
          <Button
            variant="tertiary"
            size="sm"
            svgOnly
            aria-label={`Raise Shields on ${exception.key}`}
            onClick={() => void ask({ type: "setSite", site: exception.key, enabled: true })}
          >
            <X aria-hidden="true" />
          </Button>
        </Row>
      ))}
      <Block>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input aria-label="Site" value={site} placeholder="example.com" onChange={(event) => setSite(event.target.value)} containerClassName="flex-1" data-testid="shields-exception-input" />
          <Button type="submit" variant="secondary" size="sm" disabled={site.trim() === ""}>
            Add site
          </Button>
        </form>
      </Block>
    </Group>
  );
}
