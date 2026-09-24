/**
 * The settings page's layout primitives, on Geist's Fieldset.
 *
 * A group is a fieldset: it names itself inside its own frame, with the
 * explanation under the name and the controls stacked below — no eyebrow
 * floating above the card. A row is a readable width with its explanation
 * under the label, because for a grant ceiling the explanation is the part
 * that stops a switch from being flipped blind. A footer carries whatever
 * the group as a whole has to say, and its action.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Note } from "../ui/note";
import {
  Fieldset,
  FieldsetContent,
  FieldsetFooter,
  FieldsetFooterActions,
  FieldsetFooterStatus,
  FieldsetSubtitle,
  FieldsetTitle,
} from "../ui/fieldset";
import { isShellUnsupported } from "@pistachio/shell-contracts/socket";
import type { SettingsSection } from "@pistachio/shell-contracts/settings";
import { accountHref } from "../../lib/account-link";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";

export function Page({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-175 px-8 pt-8 pb-16 @max-md:px-4">
      <header className="mb-6">
        <h1 className="text-heading-20 text-gray-1000 @md:text-heading-24">{title}</h1>
        <p className="mt-1.5 max-w-160 text-copy-14 text-gray-900">{description}</p>
      </header>
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}

/**
 * A Geist fieldset. `title` omitted ⇒ a bare card, for a group whose page
 * title already named it.
 */
export function Group({
  title,
  note,
  footer,
  footerAction,
  footerHighlight = false,
  type,
  children,
}: {
  title?: string;
  note?: string;
  /** Footer prose: what the whole group is subject to. */
  footer?: React.ReactNode;
  /** Footer control, right-aligned across from `footer`. */
  footerAction?: React.ReactNode;
  footerHighlight?: boolean;
  type?: "error" | "warning";
  children: React.ReactNode;
}) {
  const titled = title !== undefined || note !== undefined;
  const empty = children === null || children === undefined || children === false;
  return (
    <Fieldset type={type}>
      {titled ? (
        <FieldsetContent className="pb-3.5">
          {title === undefined ? null : <FieldsetTitle>{title}</FieldsetTitle>}
          {note === undefined ? null : <FieldsetSubtitle>{note}</FieldsetSubtitle>}
        </FieldsetContent>
      ) : null}
      {empty ? null : (
        <div className={cn("divide-y divide-alpha-400", titled && "border-t border-alpha-400")}>{children}</div>
      )}
      {footer === undefined && footerAction === undefined ? null : (
        <FieldsetFooter highlight={footerHighlight}>
          {footer === undefined ? null : <FieldsetFooterStatus>{footer}</FieldsetFooterStatus>}
          {footerAction === undefined ? null : <FieldsetFooterActions>{footerAction}</FieldsetFooterActions>}
        </FieldsetFooter>
      )}
    </Fieldset>
  );
}

/**
 * One setting. The control is right-aligned and never shrinks; the label and
 * its explanation take the slack — down to a floor. Below it the control
 * wraps under the label rather than over it: the page shares the window
 * with the sidebar and the agent chat, and at the smallest window with
 * both open a select would otherwise sit on top of its own name.
 */
export function Row({
  label,
  note,
  children,
}: {
  label: React.ReactNode;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3 px-5 py-3.5 @max-md:px-4">
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-label-14 text-gray-1000">{label}</p>
        {note === undefined ? null : <p className="mt-1 text-copy-13 leading-4.5 text-gray-900">{note}</p>}
      </div>
      {children === undefined ? null : <div className="max-w-full shrink-0 pt-0.5">{children}</div>}
    </div>
  );
}

/** A row whose content is a full-width block rather than a trailing control. */
export function Block({
  label,
  note,
  children,
}: {
  label?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-3.5 @max-md:px-4">
      {label === undefined ? null : <p className="text-label-14 text-gray-1000">{label}</p>}
      {note === undefined ? null : <p className="mt-1 mb-3 text-copy-13 leading-4.5 text-gray-900">{note}</p>}
      {children}
    </div>
  );
}

/**
 * A fact the page states rather than a knob it offers: an invariant of the
 * trust design (agent storage is wiped, credentials never reach the agent).
 * Drawn as a row with a badge instead of a switch, so a person can see WHY
 * there is nothing to turn off.
 */
export function Fixed({
  label,
  note,
  badge = "Always on",
  tone = "green",
}: {
  label: string;
  note: string;
  badge?: string;
  /** Gray for a fact that is not a guarantee — something planned, say. */
  tone?: "green" | "gray";
}) {
  return (
    <Row label={label} note={note}>
      <Badge variant={tone === "green" ? "green-subtle" : "gray-subtle"} size="sm">
        {badge}
      </Badge>
    </Row>
  );
}

/**
 * A secret the control plane hands over exactly once — a recovery code, a
 * channel's signing secret. Shown with the warning that makes "once"
 * survivable, and a copy button, because the alternative is a person
 * transcribing 40 characters by eye.
 *
 * Deliberately not stored anywhere on the way here: the value arrives on the
 * answer to the call that minted it and lives in that page's state until the
 * page goes away.
 */
export function OneTimeSecret({
  value,
  warning,
  testId,
  label,
}: {
  value: string;
  warning: React.ReactNode;
  testId: string;
  /** Names the value when a page shows more than one kind. */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2.5" data-testid={testId}>
      <Note type="warning" size="sm">
        {warning}
      </Note>
      {label === undefined ? null : <p className="text-label-12 font-medium text-gray-1000">{label}</p>}
      <div className="flex items-start gap-2 rounded-md bg-background-200 px-3.5 py-3 shadow-border">
        <code className="min-w-0 flex-1 font-mono text-label-13 leading-5 break-all text-gray-1000 select-all">{value}</code>
        <Button
          variant="secondary"
          size="sm"
          prefix={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
          data-testid={`${testId}-copy`}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * What a section shows when this host cannot answer for it at all
 * (docs/web-browser-design.md §11, W12).
 *
 * The rule is that an affordance is either there and works, or is visibly
 * unavailable with a reason — never a control that quietly does nothing. So
 * a section whose whole subject the host refuses renders this instead of its
 * controls, and the sentence is the HOST's own: it is the one that knows why.
 */
export function Unavailable({
  title,
  description,
  reason,
  section,
}: {
  title: string;
  description: string;
  reason: string;
  /**
   * Which section this is, so the way out lands on the page that answers
   * for it rather than on the dashboard's front door. Omitted where the
   * dashboard has no page of its own for the subject.
   */
  section?: SettingsSection;
}) {
  return (
    <Page title={title} description={description}>
      <Group>
        <Row label="Not available here" note={reason}>
          <AccountLink section={section} />
        </Row>
      </Group>
    </Page>
  );
}

/**
 * The way to the site that DOES answer, when the shell is running somewhere
 * that knows where it is (docs/web-browser-design.md §15).
 *
 * Most of what a cloud host refuses it refuses because the web dashboard owns
 * it — the account, devices, billing, the vault. The reason sentence is the
 * host's and says so; the address is the app's, and only the browser app has
 * it, so it arrives on the surface as the DASHBOARD'S ROOT — the site's own
 * front page is not where an account is managed. Which page under it is the
 * section's, through `accountHref`. On the desktop there is no such link and
 * this renders nothing.
 */
function AccountLink({ section }: { section?: SettingsSection }) {
  const surface = useSurface();
  const href = accountHref(surface.kind === "stream" ? surface.accountUrl : undefined, section);
  if (href === null) return null;
  return (
    <Button asChild size="sm" variant="secondary">
      <a href={href} target="_blank" rel="noreferrer noopener" data-testid="settings-account-link">
        Open the web app
      </a>
    </Button>
  );
}

/**
 * The reason this host gave for refusing `member`, or null when it answers.
 * A section calls this with the member its controls depend on.
 */
export function useUnavailable(member: string): string | null {
  return useAppStore((state) => state.unavailable[member] ?? null);
}

/**
 * What a section shows when the host DID NOT ANSWER — a control plane that
 * failed, a socket that dropped, a getter that timed out.
 *
 * Deliberately not `Unavailable`: "this host cannot do that" and "that did
 * not load" are opposite things to a reader. The first is a fact about the
 * product and the second is a fault, and rendering a fault as a fact is how
 * a cloud status that 500'd becomes "the cloud browser is off" with a button
 * that would have worked.
 */
export function LoadFailed({
  title,
  description,
  reason,
}: {
  title: string;
  description: string;
  reason: string;
}) {
  return (
    <Page title={title} description={description}>
      <Group type="error" title="This did not load" note="Nothing below is what this host says; it is what could not be asked.">
        <Row label="The host answered" note={reason} />
      </Group>
    </Page>
  );
}

/** The failure this host reported for `member`, or null when it answered. */
export function useLoadFailure(member: string): string | null {
  return useAppStore((state) => state.failed[member] ?? null);
}

/**
 * Run one of a section's own calls and remember how it REFUSED, so a page
 * whose member is not in the initial load's probe set still gets W12's rule:
 * `vaultList` and `integrationProviders` are only knowable at first use (one
 * needs a Space, the other is not worth a startup round trip), and before
 * this their `useUnavailable` could never fire — the guard was written and
 * never reached. The call's own rejection is re-thrown: the caller still
 * shows it the first time, and the page renders `Unavailable` after it.
 */
export async function probe<T>(member: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    useAppStore.getState().noteRefusal(member, error);
    throw error;
  }
}

/**
 * Ask a member the page has NOTHING ELSE to ask it for, purely to learn
 * whether this host refuses the subject outright (W12).
 *
 * A page whose data call is skipped — no Space, not enrolled — never reaches
 * `probe`, so its `useUnavailable` guard could never fire and a cloud host
 * that owns none of the subject still rendered a screen of controls it would
 * refuse. This asks anyway, and records ONLY a refusal: an unenrolled desktop
 * has no vault to read, and rendering that as "this did not load" would turn
 * an ordinary state into a fault.
 */
export async function probeRefusal(member: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    if (isShellUnsupported(error)) useAppStore.getState().noteRefusal(member, error);
  }
}
