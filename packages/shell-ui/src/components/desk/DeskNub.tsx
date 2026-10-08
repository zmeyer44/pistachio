import { useId, useLayoutEffect, useRef, type RefObject } from "react";
import { History, Keyboard, Mic, Sparkles, X } from "lucide-react";
import { NUB_DROP_R, nubDrops, NUB_SWELL, type NotchShape } from "../../lib/desk/geometry";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { NubMotion, type PillParts } from "./nub-motion";

/** The nub's box (`.desk-nub`): the desk's trailing foot corner is its own bottom-right, the droplets' column above the nub. */
export const NUB_BOX = { w: 72, h: 216 } as const;

/**
 * The nub's mark: the agent's sparkle in the group's colour — the menu's
 * close while its droplets are out — the arc that runs round it while the
 * agent works, and a dot while the answer floats on the desk. The shell's
 * own nub's, and the notch view's over a live page (NotchApp), so the two
 * are one face.
 */
export function DeskNubMark({ ref, acting, floating }: { ref?: React.Ref<HTMLSpanElement>; acting: boolean; floating: boolean }) {
  return (
    <span ref={ref} className="desk-nub-mark" data-acting={acting ? "" : undefined}>
      <span className="desk-nub-ring" />
      <Sparkles className="desk-nub-spark" aria-hidden="true" />
      <X className="desk-nub-close" aria-hidden="true" />
      {floating ? <span className="desk-nub-dot" data-testid="desk-nub-floating" /> : null}
    </span>
  );
}

/** A tooltip over one of the nub's droplets, or the nub (DeskBar's, as its Bar's): open as Base UI says, seen once no live page is under it. */
export interface NubTip {
  open: boolean;
  shown: boolean;
  onOpenChange: (open: boolean) => void;
}

/** What each droplet is: the prompt nearest the nub, the microphone, past chats on top. */
const ITEMS = [
  { testId: "desk-nub-prompt", label: "Write to Pistachio", icon: Keyboard },
  { testId: "desk-nub-mic", label: "Dictate", icon: Mic },
  { testId: "desk-nub-chats", label: "Past chats", icon: History },
] as const;

/**
 * The Bar's nub (docs/desk-agent.md §1): a droplet of the shell's ground in
 * the desk's trailing foot corner — a hole the engine cuts, not painted —
 * with its mark; a click lets its menu out, three droplets that pinch off
 * up the trailing edge (the prompt, the microphone, past chats), and merges
 * them back. What is painted of it is the goo (NubPaint): the nub's own
 * outline, filled with the card's fill while the droplets are out, and the
 * droplets themselves, blurred and thresholded so they melt together where
 * they meet. nub-motion.ts moves all of it; this draws its parts once.
 */
export function DeskNub({
  nubRef,
  faceRef,
  motionRef,
  pill,
  onShape,
  corner,
  label,
  acting,
  floating,
  menuOpen,
  chatsOpen,
  hovered,
  faceTip,
  tip,
  onFaceEnter,
  onFaceLeave,
  onFace,
  onPrompt,
  onMic,
  onChats,
  children,
}: {
  nubRef: RefObject<HTMLDivElement | null>;
  faceRef: RefObject<HTMLButtonElement | null>;
  motionRef: RefObject<NubMotion | null>;
  pill: () => PillParts | null;
  onShape: (shape: NotchShape) => void;
  corner: () => number;
  /** What the nub is for ("Ask about Research"), and its key, for its tooltip and its name. */
  label: { text: string; shortcut: string | null };
  acting: boolean;
  floating: boolean;
  menuOpen: boolean;
  /** The conversations grown out of the past-chats droplet. */
  chatsOpen: boolean;
  hovered: boolean;
  faceTip: NubTip;
  tip: (label: string) => NubTip;
  onFaceEnter: () => void;
  onFaceLeave: () => void;
  /** A click (or Enter) on the nub: `keyboard`, from the keys — the first droplet then has them. */
  onFace: (keyboard: boolean) => void;
  onPrompt: () => void;
  onMic: () => void;
  onChats: () => void;
  /** The conversations, in the nub's box. */
  children?: React.ReactNode;
}) {
  const paintRef = useRef<SVGSVGElement>(null);
  const baseRef = useRef<SVGPathElement>(null);
  const blobRef = useRef<SVGCircleElement>(null);
  const dropRefs = useRef<Array<SVGEllipseElement | null>>([]);
  const neckRefs = useRef<Array<SVGLineElement | null>>([]);
  const bridgeRef = useRef<SVGLineElement>(null);
  const bridgeEndRef = useRef<SVGCircleElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // (React's ids carry characters a url() reference would have to escape.)
  const gooId = `desk-nub-goo-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // The latest of what the motion asks of the Bar, without making it anew.
  const host = useRef({ pill, onShape, corner });
  host.current = { pill, onShape, corner };

  useLayoutEffect(() => {
    const root = nubRef.current;
    const paint = paintRef.current;
    const base = baseRef.current;
    const blob = blobRef.current;
    const bridge = bridgeRef.current;
    const bridgeEnd = bridgeEndRef.current;
    const face = faceRef.current;
    const mark = markRef.current;
    const drops = dropRefs.current.filter((el): el is SVGEllipseElement => el !== null);
    const necks = neckRefs.current.filter((el): el is SVGLineElement => el !== null);
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    if (root === null || paint === null || base === null || blob === null || bridge === null || bridgeEnd === null || face === null || mark === null) return;
    const motion = new NubMotion({
      parts: { root, paint, base, blob, drops, necks, bridge, bridgeEnd, face, mark, items },
      pill: () => host.current.pill(),
      corner: () => host.current.corner(),
      shape: (shape) => host.current.onShape(shape),
    });
    motionRef.current = motion;
    // The desk resized, or its corners changed (the window's frame): drawn again.
    const stage = root.closest(".desk-stage");
    const observer = new ResizeObserver(() => motion.refresh());
    if (stage !== null) observer.observe(stage);
    return () => {
      observer.disconnect();
      motion.destroy();
      motionRef.current = null;
    };
  }, [nubRef, faceRef, motionRef]);

  const rests = nubDrops(NUB_SWELL);
  const { w, h } = NUB_BOX;
  return (
    <div ref={nubRef} className="desk-nub" data-testid="desk-nub-box" data-open={menuOpen ? "" : undefined} style={{ width: w, height: h }}>
      {/* The goo: in the corner's own coordinates (its viewBox drawn from the corner), clipped to the desk's curve. */}
      <div className="desk-nub-paint" aria-hidden="true">
        <svg ref={paintRef} viewBox={`${String(-w)} ${String(-h)} ${String(w)} ${String(h)}`}>
          <defs>
            <filter id={gooId} filterUnits="userSpaceOnUse" x={-w - 20} y={-h - 20} width={w + 60} height={h + 60} colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
              <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8.5" />
            </filter>
          </defs>
          <path ref={baseRef} />
          <g filter={`url(#${gooId})`}>
            <circle ref={blobRef} r="0" />
            {rests.map((_, i) => (
              <line
                key={`neck-${String(i)}`}
                ref={(el) => {
                  neckRefs.current[i] = el;
                }}
                strokeWidth="0"
              />
            ))}
            {rests.map((_, i) => (
              <ellipse
                key={`drop-${String(i)}`}
                ref={(el) => {
                  dropRefs.current[i] = el;
                }}
                rx="0"
                ry="0"
              />
            ))}
            <line ref={bridgeRef} strokeWidth="0" />
            <circle ref={bridgeEndRef} r="0" />
          </g>
        </svg>
      </div>
      <Tooltip open={faceTip.open} onOpenChange={faceTip.onOpenChange}>
        <TooltipTrigger
          ref={faceRef}
          type="button"
          className="desk-nub-face"
          data-testid="desk-nub"
          data-hovered={hovered ? "" : undefined}
          data-acting={acting ? "" : undefined}
          data-floating={floating ? "" : undefined}
          aria-label={label.text}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={`${gooId}-menu`}
          // A press leaves the keyboard where it was.
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={onFaceEnter}
          onPointerLeave={onFaceLeave}
          onClick={(event) => onFace(event.detail === 0)}
        >
          <DeskNubMark ref={markRef} acting={acting} floating={floating} />
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={10} data-testid="desk-bar-tip" data-shown={faceTip.shown ? "" : undefined} className={faceTip.shown ? "whitespace-nowrap" : "whitespace-nowrap opacity-0"}>
          {label.text}
          {label.shortcut === null ? null : <span className="ml-1 text-background-100/60">{label.shortcut}</span>}
        </TooltipContent>
      </Tooltip>
      <div
        id={`${gooId}-menu`}
        role="menu"
        aria-label="Pistachio"
        aria-orientation="vertical"
        className="desk-nub-menu"
        data-testid="desk-nub-menu"
        data-open={menuOpen ? "" : undefined}
        inert={!menuOpen}
        onKeyDown={(event) => {
          // Up the column and down it; the prompt is at its foot.
          const at = itemRefs.current.findIndex((el) => el === document.activeElement);
          if (at < 0) return;
          const next = event.key === "ArrowUp" ? at + 1 : event.key === "ArrowDown" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? ITEMS.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          itemRefs.current[(next + ITEMS.length) % ITEMS.length]?.focus({ preventScroll: true });
        }}
      >
        {ITEMS.map((item, i) => {
          const rest = rests[i]!;
          const Icon = item.icon;
          const itemTip = tip(item.label);
          const onClick = i === 0 ? onPrompt : i === 1 ? onMic : onChats;
          return (
            <Tooltip key={item.testId} open={itemTip.open} onOpenChange={itemTip.onOpenChange}>
              <TooltipTrigger
                ref={(el: HTMLButtonElement | null) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                className="desk-nub-item"
                data-testid={item.testId}
                aria-label={item.label}
                aria-expanded={i === 2 ? chatsOpen : undefined}
                style={{ left: w + rest.x, top: h + rest.y, width: NUB_DROP_R * 2, height: NUB_DROP_R * 2 }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={10} data-testid="desk-bar-tip" data-shown={itemTip.shown ? "" : undefined} className={itemTip.shown ? "whitespace-nowrap" : "whitespace-nowrap opacity-0"}>
                {item.label}
                {/* (The prompt's is the key's too: ⌘I opens it straight.) */}
                {i === 0 && label.shortcut !== null ? <span className="ml-1 text-background-100/60">{label.shortcut}</span> : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {children}
    </div>
  );
}
