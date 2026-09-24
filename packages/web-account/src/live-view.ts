"use client";

/**
 * Watching — and driving — a cloud run's browser from this tab
 * (docs/cloud-sync-design.md §8.5).
 *
 * The runner streams JPEG screencast frames over a WebSocket and accepts
 * pointer and key events back. It authenticates the upgrade by introspecting
 * a bearer, and no WebSocket client can set a header, so the credential goes
 * in the URL — which is why this asks control for a ONE-MINUTE ticket first
 * and never puts the tab's device token there. A ticket is fetched fresh for
 * every dial, including every reconnect.
 *
 * The frames do not go through React state at their own rate: a screencast is
 * several base64 JPEGs a second, so they are coalesced to one repaint per
 * animation frame. Everything here is deliberately confined to the live pane
 * — mount it beside the thread, never above it, or every frame repaints the
 * conversation too.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeServerFrame,
  encodeClientFrame,
  liveViewUrl,
  type LiveFrame,
  type LiveInput,
  type LiveTabInfo,
} from "@pistachio/live-view";
import { liveProofSealAad, seal, toBase64, utf8, type SpaceKeys } from "@pistachio/sync-protocol";
import { ControlError, runLiveTicket } from "./control";

export type LiveState = "idle" | "connecting" | "open" | "closed" | "revoked" | "error";

/** The hub and the runner both close a revoked device's socket with this (§4, §8.5). */
const CLOSE_REVOKED = 4003;
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECTS = 5;

export interface LiveView {
  state: LiveState;
  frame: LiveFrame | null;
  tabs: LiveTabInfo[];
  activeTabId: string | null;
  /** Who drives the cloud page; input is forwarded only under `human`. */
  control: "agent" | "human" | null;
  error: string | null;
  send(input: LiveInput | null): void;
}

/**
 * Why control would not issue a ticket, in the reader's terms. These are
 * ordinary states of a run, not failures, so they must not read like one.
 */
function ticketProblem(cause: unknown): string {
  if (!(cause instanceof ControlError)) {
    return cause instanceof Error ? cause.message : "The live view could not be opened.";
  }
  switch (cause.code) {
    case "not_running":
      return "This run is not working in the cloud browser right now, so there is nothing to watch.";
    case "not_a_cloud_run":
      return "This conversation runs on your Mac, not in the cloud browser.";
    case "run_ended":
      return "This run has ended.";
    case "no_cloud_browser":
      return "No cloud browser is configured for this account.";
    case "not_found":
      return "This run is not one of yours.";
    default:
      return cause.message;
  }
}

export function useLiveView(options: {
  enabled: boolean;
  /**
   * This browser's keys for the run's Space. The runner challenges every
   * viewer to prove it holds them before it sends a pixel (§8.5), so without
   * these the socket opens and then closes — which is the point: a tab that
   * cannot read what the run said does not get to watch it happen.
   */
  keys: SpaceKeys | null;
  runId: string;
  token: string | null;
}): LiveView {
  const { enabled, keys, runId, token } = options;
  const [state, setState] = useState<LiveState>("idle");
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [tabs, setTabs] = useState<LiveTabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [control, setControl] = useState<"agent" | "human" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const socket = useRef<WebSocket | null>(null);
  // Input is dropped rather than queued when the person does not hold
  // control, so `send` reads the live value without re-subscribing.
  const controlRef = useRef<"agent" | "human" | null>(null);
  controlRef.current = control;

  useEffect(() => {
    if (!enabled || token === null) {
      setState("idle");
      return;
    }
    // A generation guard: everything below checks it before touching state,
    // so a socket from a previous run or a previous mount cannot paint over
    // the current one.
    let live = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    let pending: (LiveFrame & { t: "frame" }) | null = null;
    /** Set when the runner said why it is closing: not a drop, do not redial. */
    let final = false;

    setFrame(null);
    setTabs([]);
    setActiveTabId(null);
    setControl(null);
    setError(null);

    const paint = (next: LiveFrame & { t: "frame" }): void => {
      pending = next;
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (live && pending !== null) setFrame(pending);
      });
    };

    /** Answer the runner's challenge: the nonce sealed under the Space key. */
    const prove = async (ws: WebSocket, nonce: string): Promise<void> => {
      if (keys === null) {
        setError("This browser holds no key for this run's Space, so it cannot watch it.");
        setState("error");
        ws.close(1000, "no space key");
        return;
      }
      let proof: string;
      try {
        proof = toBase64(await seal(keys.sealKey, utf8(nonce), liveProofSealAad(runId, nonce)));
      } catch {
        setError("This browser could not answer the cloud browser's challenge.");
        setState("error");
        ws.close(1000, "proof failed");
        return;
      }
      if (live && ws.readyState === WebSocket.OPEN) ws.send(encodeClientFrame({ t: "auth", proof }));
    };

    const onMessage = (ws: WebSocket, data: unknown): void => {
      const frame = decodeServerFrame(data);
      if (frame === null) return;
      switch (frame.t) {
        case "challenge":
          void prove(ws, frame.nonce);
          return;
        case "frame":
          paint(frame);
          return;
        case "tabs":
          setTabs(frame.tabs);
          setActiveTabId(frame.activeTabId);
          return;
        case "status":
          setControl(frame.control);
          return;
        case "error":
          // The runner closes the socket next; remember why, so the close
          // does not read as a dropped connection. Every code it sends is
          // terminal, so none of them is worth re-dialling.
          final = true;
          setError(frame.message);
          return;
      }
    };

    const dial = async (): Promise<void> => {
      setState("connecting");
      let ticket;
      try {
        ticket = await runLiveTicket(token, runId);
      } catch (cause: unknown) {
        if (!live) return;
        setError(ticketProblem(cause));
        setState("error");
        return;
      }
      if (!live) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(liveViewUrl(ticket.url, runId, ticket.ticket));
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : "The cloud browser could not be reached.");
        setState("error");
        return;
      }
      socket.current = ws;
      ws.addEventListener("open", () => {
        if (!live) return;
        attempts = 0;
        setState("open");
      });
      ws.addEventListener("message", (event) => {
        if (live) onMessage(ws, event.data);
      });
      ws.addEventListener("close", (event) => {
        if (!live) return;
        socket.current = null;
        if (event.code === CLOSE_REVOKED) {
          setError("This browser is no longer allowed to watch — its key was revoked.");
          setState("revoked");
          return;
        }
        if (final) {
          setState("closed");
          return;
        }
        if (attempts >= MAX_RECONNECTS) {
          setError((current) => current ?? "The live view disconnected.");
          setState("error");
          return;
        }
        attempts += 1;
        setState("connecting");
        timer = setTimeout(() => void dial(), RECONNECT_DELAY_MS);
      });
      // The close that follows carries the code; nothing to decide here.
      ws.addEventListener("error", () => undefined);
    };

    void dial();

    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
      if (raf !== 0) window.cancelAnimationFrame(raf);
      socket.current?.close(1000, "closed");
      socket.current = null;
    };
  }, [enabled, keys, runId, token]);

  const send = useCallback((input: LiveInput | null): void => {
    const ws = socket.current;
    if (input === null || ws === null || ws.readyState !== WebSocket.OPEN) return;
    // The runner drops input unless the person holds control. Dropping it
    // here too keeps a stray pointer event off the wire entirely.
    if (input.t === "input" && controlRef.current !== "human") return;
    ws.send(JSON.stringify(input));
  }, []);

  return { state, frame, tabs, activeTabId, control, error, send };
}
