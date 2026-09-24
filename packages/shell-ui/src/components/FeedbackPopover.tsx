import { Megaphone } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FEEDBACK_REACTIONS, MAX_FEEDBACK_MESSAGE, type FeedbackReaction } from "@pistachio/protocol";
import { cn } from "../lib/cn";
import { useAppStore } from "../store";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

/**
 * Geist's Feedback popover, in the console header: a textarea, an emoji row,
 * and Send. What is sent carries the whole conversation (main attaches it),
 * so a report is enough to reproduce what the person saw. Success shows in
 * place and closes on its own; failure stays open with the reason, and the
 * draft, intact.
 */

const REACTION: Record<FeedbackReaction, { emoji: string; label: string }> = {
  love: { emoji: "🤩", label: "Loved it" },
  happy: { emoji: "🙂", label: "Liked it" },
  sad: { emoji: "🙁", label: "Didn't like it" },
  crying: { emoji: "😭", label: "Hated it" },
};

const SENT_VISIBLE_MS = 1_800;

type Phase = { kind: "editing" } | { kind: "sending" } | { kind: "sent" } | { kind: "failed"; error: string };

export function FeedbackPopover() {
  const submitFeedback = useAppStore((state) => state.submitFeedback);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [reaction, setReaction] = useState<FeedbackReaction | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Open lands focus in the field; a click elsewhere or Escape closes. Both
  // listen in the capture phase so the page's own Escape handlers stay out.
  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, close]);

  // A received report is acknowledged in place, then the popover closes and
  // the next one starts blank.
  useEffect(() => {
    if (phase.kind !== "sent") return;
    const timer = window.setTimeout(() => {
      setOpen(false);
      setMessage("");
      setReaction(null);
      setPhase({ kind: "editing" });
    }, SENT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [phase.kind]);

  const ready = message.trim() !== "" && phase.kind !== "sending";
  const send = async () => {
    if (!ready) return;
    setPhase({ kind: "sending" });
    const outcome = await submitFeedback({ message, reaction });
    setPhase(outcome.ok ? { kind: "sent" } : { kind: "failed", error: outcome.error });
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        variant="tertiary"
        size="xs"
        svgOnly
        aria-label="Send feedback"
        title="Feedback"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="console-feedback"
        className={cn(open && "bg-alpha-100")}
        onClick={() => setOpen((current) => !current)}
      >
        <Megaphone aria-hidden="true" />
      </Button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Feedback"
          data-testid="feedback-popover"
          className="animate-overlay-in absolute top-full right-0 z-30 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-alpha-400 bg-background-100 p-2 shadow-modal"
        >
          {phase.kind === "sent" ? (
            <div role="status" className="grid place-items-center gap-1 px-2 py-7 text-center">
              <strong className="text-label-14 font-medium text-gray-1000">Your feedback has been received!</strong>
              <span className="text-copy-13 text-gray-900">Thank you for your help.</span>
            </div>
          ) : (
            <>
              <Textarea
                ref={textareaRef}
                aria-label="Your feedback"
                placeholder="Your feedback..."
                rows={4}
                maxLength={MAX_FEEDBACK_MESSAGE}
                value={message}
                disabled={phase.kind === "sending"}
                className="min-h-24 text-copy-13"
                onChange={(event) => {
                  setMessage(event.target.value);
                  if (phase.kind === "failed") setPhase({ kind: "editing" });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {phase.kind === "failed" ? (
                <p role="alert" className="mt-1.5 px-1 text-[11px] leading-4 wrap-anywhere text-red-900">
                  {phase.error}
                </p>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-2">
                <div role="radiogroup" aria-label="How was it?" className="flex items-center gap-0.5">
                  {FEEDBACK_REACTIONS.map((option) => {
                    const selected = reaction === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={REACTION[option].label}
                        title={REACTION[option].label}
                        disabled={phase.kind === "sending"}
                        className={cn(
                          "grid size-7 cursor-pointer place-items-center rounded-full text-[15px] leading-none outline-none transition-[background-color,transform,box-shadow] duration-150 hover:scale-110 hover:bg-alpha-100 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                          selected && "bg-blue-100 shadow-[0_0_0_1px_var(--color-blue-700)]",
                        )}
                        onClick={() => setReaction((current) => (current === option ? null : option))}
                      >
                        <span aria-hidden="true">{REACTION[option].emoji}</span>
                      </button>
                    );
                  })}
                </div>
                <Button size="xs" loading={phase.kind === "sending"} disabled={!ready} onClick={() => void send()}>
                  Send
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
