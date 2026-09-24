"use client";

import { useEffect, useRef, useState, type RefObject, type KeyboardEvent } from "react";
import { keyInput } from "@pistachio/live-view";
import type { WsShellApi, ShellInputEvent } from "../lib/shell-socket";
import { useShellControl } from "./streamed-pane";

type Pending = { text: string } | { event: ShellInputEvent };

/** A stable native input target survives the DOM → pixels transition. Text
 * (including paste and IME commits) waits for cloud focus acknowledgement. */
export function EditorInput({ api, tabId, request, inputRef, onReady }: {
  api: WsShellApi; tabId: string; request: { epoch: number; id: number; point?: { fx: number; fy: number; modifiers: number } };
  inputRef: RefObject<HTMLTextAreaElement | null>; onReady(): void;
}) {
  const control = useShellControl(api);
  const generation = useRef(control.generation);
  const queue = useRef<Pending[]>([]);
  const ready = useRef(false);
  const live = useRef(true);
  const busy = useRef(false);
  const rejected = useRef(false);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const composing = useRef(false);
  const valid = () => live.current && api.control.holder === "human" && api.control.generation === generation.current;
  const drain = async () => {
    if (busy.current || rejected.current || !ready.current || !valid()) return;
    busy.current = true;
    try {
      while (queue.current.length && valid()) {
        const item = queue.current[0]!;
        if ("text" in item) await api.pasteText(tabId, item.text);
        else api.input(tabId, item.event);
        queue.current.shift();
      }
    } catch { rejected.current = true; ready.current = false; setFailed(true); }
    finally { busy.current = false; }
  };
  const enqueue = (item: Pending) => {
    if (!valid() || failed) return;
    const last = queue.current.at(-1);
    // Combine queued text, but never mutate the insertion already in flight.
    if ("text" in item && last && "text" in last && (!busy.current || queue.current.length > 1)
      && last.text.length + item.text.length <= 1_000_000) last.text += item.text;
    else queue.current.push(item);
    void drain();
  };
  const commit = (element: HTMLTextAreaElement) => {
    if (composing.current || !element.value) return;
    enqueue({ text: element.value }); element.value = "";
  };
  useEffect(() => {
    live.current = true;
    inputRef.current?.focus({ preventScroll: true });
    const off = api.onMirror(tabId, message => {
      if (message.k !== "editorFocused" || message.epoch !== request.epoch || message.id !== request.id || rejected.current || !valid()) return;
      clearTimeout(timer);
      if (!message.ok) { rejected.current = true; setFailed(true); return; }
      ready.current = true; setWaiting(false); onReady(); void drain();
    });
    const timer = setTimeout(() => { rejected.current = true; setFailed(true); }, 8_000);
    api.mirror(tabId, { k: "focusEditor", frame: "main", ...request });
    return () => { live.current = false; clearTimeout(timer); off(); };
    // The request owns this input lifetime. Callbacks only read stable refs/API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tabId, request, inputRef, onReady]);
  useEffect(() => {
    if (control.holder !== "human" || control.generation !== generation.current) {
      rejected.current = true; ready.current = false; setFailed(true);
    }
  }, [control.holder, control.generation]);
  const key = (event: KeyboardEvent<HTMLTextAreaElement>, type: "keyDown" | "keyUp") => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || composing.current || event.key === "Process") return;
    // The native textarea emits text/paste/composition once through input.
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    const input = keyInput(event, type);
    if (input?.t === "input") enqueue({ event: input.event });
  };
  return <>
    <textarea ref={inputRef} aria-label="Cloud editor input" data-testid="cloud-editor-input"
      className="absolute left-0 top-0 size-px opacity-0" autoComplete="off" spellCheck={false}
      disabled={failed || control.holder !== "human" || control.generation !== generation.current}
      onKeyDown={event => key(event, "keyDown")} onKeyUp={event => key(event, "keyUp")}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; commit(event.currentTarget); }}
      onInput={event => commit(event.currentTarget)}
      onPaste={event => { event.preventDefault(); event.stopPropagation(); enqueue({ text: event.clipboardData.getData("text/plain") }); }} />
    {waiting || failed ? <div role="status" className="absolute bottom-3 left-3 z-30 max-w-sm rounded-md bg-background-100 p-3 text-label-12 shadow-modal">
      {failed ? "The editor could not receive your input. Your pending text is shown below; copy it before retrying." : "Opening editor…"}
      {failed ? <textarea className="mt-2 block w-full rounded border border-gray-400 p-2" aria-label="Unsent editor text" readOnly value={queue.current.map(item => "text" in item ? item.text : "").join("")} /> : null}
    </div> : null}
  </>;
}
