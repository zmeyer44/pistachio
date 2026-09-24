"use client";

/**
 * The signed-in shell: a skip link, the rail, and the page.
 *
 * The rail follows the Vercel dashboard's anatomy — the workspace it is
 * scoped to at the top, a find field, the nav, anything demanding attention,
 * and the person at the bottom. The two menus are deliberately not the same
 * menu: the top one answers "which workspace am I looking at", the bottom one
 * "who am I here as".
 *
 * The shell also decides what a reader is allowed to see — signed out,
 * locked, or through to the app — so no page has to guard itself.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { AlertTriangle, Check, ChevronsUpDown, LogOut, MoreHorizontal } from "lucide-react";
import { Loading, NotSetUp, PinGate, SignIn, Unlock, useSession } from "@pistachio/web-account";
import { cn } from "../../lib/utils";
import { SidebarNav } from "./sidebar-nav";

export function Shell({ children }: { children: ReactNode }): ReactNode {
  const session = useSession();

  if (session.state === "loading") return <Loading />;
  if (session.state === "signed-out") return <SignIn />;
  // A browser holding a sealed session asks for six digits, not a password;
  // a session that has just chosen one is choosing it here too. `unlocking` is
  // whichever of the two finishing its own animation.
  if (session.state === "pin" || session.state === "set-pin" || session.state === "unlocking") return <PinGate />;
  if (session.state === "locked") return <Unlock />;
  if (session.state === "unprovisioned") return <NotSetUp />;

  return (
    <>
      <a className="pa-skip" href="#main">
        Skip to content
      </a>
      <div className="pa-shell">
        <div className="pa-side">
          <WorkspaceChip />
          <SidebarNav />
          <ActionRequired />
          <PersonRow />
        </div>

        <main id="main" className="pa-main">
          {children}
        </main>
      </div>
    </>
  );
}

/* ------------------------------- the menus -------------------------------- */

/**
 * A menu anchored to its trigger. Closes on Escape, on a click outside, and on
 * any activation inside it — a menu that stays open behind a navigation is a
 * menu you have to dismiss twice.
 *
 * It opens downwards, and FLIPS UP when the viewport has no room below: the
 * rail is a full-height column, so its bottom row's menu would otherwise open
 * past the bottom edge and be unreachable. The flip is measured from the
 * mounted panel (a ref callback, so it lands before paint — no visible jump)
 * and re-measured on resize. Whichever side wins, the panel is also capped to
 * the space actually available and scrolls inside it, so a menu taller than
 * the viewport still shows its first rows rather than spilling off-screen.
 */
function Popover({
  align = "start",
  children,
  label,
  trigger,
}: {
  align?: "start" | "end";
  children: ReactNode;
  label: string;
  trigger: (props: { "aria-expanded": boolean; "aria-haspopup": "menu"; id: string; open: boolean }) => ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({ maxHeight: 0, side: "bottom" });
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    const onResize = (): void => {
      measure(panel.current, setPlacement);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <div className="relative" ref={root}>
      <div
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {trigger({ "aria-expanded": open, "aria-haspopup": "menu", id, open })}
      </div>
      {!open ? null : (
        <div
          role="menu"
          aria-label={label}
          aria-labelledby={id}
          data-side={placement.side}
          onClick={() => {
            setOpen(false);
          }}
          // A ref callback rather than a layout effect: it runs on the client
          // only, so measuring costs no SSR warning, and it still lands before
          // the browser paints the panel.
          ref={(node) => {
            panel.current = node;
            measure(node, setPlacement);
          }}
          style={placement.maxHeight === 0 ? undefined : { maxHeight: placement.maxHeight }}
          className={cn(
            "pa-pop scroll-thin absolute z-30 flex w-[236px] flex-col gap-0.5 overflow-y-auto rounded-lg bg-background-100 p-1 shadow-menu",
            align === "end" ? "right-0" : "left-0",
            placement.side === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface Placement {
  /** 0 until the panel has been measured, meaning "uncapped". */
  maxHeight: number;
  side: "bottom" | "top";
}

/** Clear of the viewport edge, and of the gap the panel already holds. */
const POP_GAP = 12;

/**
 * Picks the side with room for the panel, preferring below on a tie so a menu
 * that fits either way keeps its usual place. Measures the panel unclamped —
 * `scrollHeight` on the box whose height we are about to cap — so a second
 * pass cannot mistake an earlier cap for the content's real height.
 */
function measure(node: HTMLDivElement | null, setPlacement: Dispatch<SetStateAction<Placement>>): void {
  // The offsetParent is the `relative` root, whose box is the trigger's: the
  // panel itself is out of flow and does not grow it.
  const anchor = node?.offsetParent ?? null;
  if (node === null || !(anchor instanceof HTMLElement)) return;
  const rect = anchor.getBoundingClientRect();
  const wanted = node.scrollHeight;
  const below = window.innerHeight - rect.bottom - POP_GAP;
  const above = rect.top - POP_GAP;
  const side = wanted > below && above > below ? "top" : "bottom";
  const maxHeight = Math.max(Math.round(side === "top" ? above : below), 0);
  // Keeping the previous object when nothing moved is load-bearing: the ref
  // callback runs on every render, so a fresh object every time would be a new
  // state value every time, and the two would drive each other forever.
  setPlacement((prev) => (prev.side === side && prev.maxHeight === maxHeight ? prev : { maxHeight, side }));
}

const MENU_ROW =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-label-14 text-gray-1000 no-underline outline-none transition-colors hover:bg-alpha-100";

function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  return <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-gray-700">{children}</p>;
}

function MenuRule(): ReactNode {
  return <div aria-hidden="true" className="my-1 h-px bg-alpha-400" />;
}

/* ------------------------------ the workspace ----------------------------- */

/** The initial Vercel puts in the team avatar. */
function Avatar({ className, seed }: { className?: string; seed: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gray-1000 text-[11px] font-medium text-background-100 uppercase",
        className ?? "size-6",
      )}
    >
      {seed.slice(0, 1)}
    </span>
  );
}

function WorkspaceChip(): ReactNode {
  const { account, workspace } = useSession();
  const email = account?.email ?? "";
  const name = email.split("@")[0] ?? "Workspace";
  const cloud = workspace.spaces.filter((space) => space.cloudEnabled).length;

  return (
    <div className="px-3 pt-3 pb-2">
      <Popover
        label="Workspace"
        trigger={({ open, ...aria }) => (
          <button
            {...aria}
            type="button"
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
              open ? "bg-alpha-100" : "hover:bg-alpha-100",
            )}
          >
            <Avatar seed={name} />
            <span className="min-w-0 flex-1 truncate text-heading-14 text-gray-1000">{name}</span>
            <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-px text-[10px] leading-4 font-medium text-blue-900">
              Cloud
            </span>
            <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-gray-700" />
          </button>
        )}
      >
        <MenuLabel>Spaces</MenuLabel>
        {workspace.spaces.length === 0 ? (
          <p className="px-2 py-1.5 text-label-13 text-gray-700">None yet. Your Mac creates them.</p>
        ) : (
          workspace.spaces.map((space) => (
            <span className={cn(MENU_ROW, "cursor-default")} key={space.id} role="menuitem" tabIndex={-1}>
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              {space.cloudEnabled ? (
                <Check aria-label="Runs in the cloud" className="size-3.5 shrink-0 text-green-700" />
              ) : null}
            </span>
          ))
        )}
        <MenuRule />
        <Link className={MENU_ROW} href="/app/spaces" role="menuitem">
          Manage Spaces
        </Link>
        <p className="px-2 pt-1 pb-1.5 text-[11px] leading-4 text-gray-700">
          {cloud === 0
            ? "No Space runs in the cloud yet."
            : `${String(cloud)} of ${String(workspace.spaces.length)} run in the cloud.`}
        </p>
      </Popover>
    </div>
  );
}

/* -------------------------------- the alert ------------------------------- */

/** The one thing most worth doing something about, or nothing at all. */
function ActionRequired(): ReactNode {
  const { hubState, vaultError, workspace, spaces } = useSession();
  const cloud = spaces.filter((space) => space.cloudEnabled).length;

  const alert =
    // First, because it is the only one that says something the reader
    // believed about this browser is not true.
    vaultError !== null
      ? { body: vaultError, title: "Stored keys" }
      : hubState === "off"
      ? {
          body: "This device was signed out from somewhere else. Sign in again to keep syncing.",
          title: "Signed out elsewhere",
        }
      : workspace.rejected > 0
        ? {
            body: `${String(workspace.rejected)} record${workspace.rejected === 1 ? "" : "s"} did not verify against a known device, and ${workspace.rejected === 1 ? "is" : "are"} being ignored.`,
            title: "Records failed verification",
          }
        : cloud === 0 && spaces.length > 0
          ? {
              body: "Open Agent and turn on the cloud browser for a Space, and runs can start from here or iMessage.",
              title: "Nothing can run here yet",
            }
          : null;

  if (alert === null) return null;

  return (
    <div className="px-3 pb-2">
      <div className="flex flex-col gap-1.5 rounded-lg border border-amber-400 bg-amber-100 p-3">
        <p className="flex items-start justify-between gap-2 text-heading-14 text-amber-1000">
          {alert.title}
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700" />
        </p>
        <p className="text-[11.5px] leading-4 text-amber-1000">{alert.body}</p>
      </div>
    </div>
  );
}

/* -------------------------------- the person ------------------------------ */

function hubLabel(state: ReturnType<typeof useSession>["hubState"]): { text: string; tone?: "good" | "alert" } {
  switch (state) {
    case "connected":
      return { text: "Synced", tone: "good" };
    case "connecting":
      return { text: "Connecting" };
    case "offline":
      return { text: "Offline", tone: "alert" };
    case "off":
      return { text: "Signed out elsewhere", tone: "alert" };
    default:
      return { text: "Not connected" };
  }
}

function PersonRow(): ReactNode {
  const { account, hubState, signOut } = useSession();
  const email = account?.email ?? "";
  const hub = hubLabel(hubState);

  return (
    <div className="flex items-center gap-2 border-t border-alpha-400 px-3 py-2">
      <Avatar className="size-6" seed={email} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label-13 text-gray-1000">{email}</span>
        <span className="pa-status">
          <span className="pa-dot" data-tone={hub.tone} />
          {hub.text}
        </span>
      </span>
      <Popover
        align="end"
        label="Account"
        trigger={({ open, ...aria }) => (
          <button
            {...aria}
            type="button"
            aria-label="Account menu"
            className={cn(
              "flex size-7 cursor-pointer items-center justify-center rounded-md text-gray-700 transition-colors hover:bg-alpha-100 hover:text-gray-1000",
              open ? "bg-alpha-100 text-gray-1000" : "",
            )}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </button>
        )}
      >
        <MenuLabel>Signed in as</MenuLabel>
        <p className="px-2 pb-1 text-label-13 break-all text-gray-1000">{email}</p>
        <MenuRule />
        <Link className={MENU_ROW} href="/app/devices" role="menuitem">
          This browser and other devices
        </Link>
        <Link className={MENU_ROW} href="/app/settings/account" role="menuitem">
          Settings
        </Link>
        <button
          className={MENU_ROW}
          onClick={() => {
            void signOut();
          }}
          role="menuitem"
          type="button"
        >
          <LogOut aria-hidden="true" className="size-4 shrink-0 text-gray-700" />
          Sign out
        </button>
      </Popover>
    </div>
  );
}
