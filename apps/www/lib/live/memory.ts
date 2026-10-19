/**
 * What the guest page keeps in the browser (docs/live-share.md §1, §5, §7):
 * the name across visits (localStorage), the devices, whether the camera and
 * microphone were on and what was behind the person (a picture of their own
 * only as having been one), and — per link, for this tab only
 * (sessionStorage) — the request a reload rejoins with.
 *
 * Storage can be off (a private window, a policy); every read and write is
 * guarded and the page works the same without it, only forgetting more.
 */

import { readBackground, type GuestMediaPrefs, type LiveGuestRequest } from "@pistachio/live-share/react";

const NAME_KEY = "pistachio.live.name";
const MEDIA_KEY = "pistachio.live.media";
const requestKey = (token: string): string => `pistachio.live.request.${token}`;

export const DEFAULT_MEDIA: GuestMediaPrefs = { microphone: true, camera: true, audioinput: null, videoinput: null, audiooutput: null, background: { kind: "none" } };

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Storage is off: nothing is remembered, nothing breaks.
  }
}

const local = (): Storage => window.localStorage;
const session = (): Storage => window.sessionStorage;

export function rememberedName(): string {
  return read(local, NAME_KEY) ?? "";
}

export function rememberName(name: string): void {
  write(local, NAME_KEY, name);
}

export function rememberedMedia(): GuestMediaPrefs {
  const raw = read(local, MEDIA_KEY);
  if (raw === null) return DEFAULT_MEDIA;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof GuestMediaPrefs, unknown>>;
    const id = (field: unknown): string | null => (typeof field === "string" && field !== "" ? field : null);
    return {
      microphone: value.microphone !== false,
      camera: value.camera !== false,
      audioinput: id(value.audioinput),
      videoinput: id(value.videoinput),
      audiooutput: id(value.audiooutput),
      background: readBackground(value.background),
    };
  } catch {
    return DEFAULT_MEDIA;
  }
}

export function rememberMedia(prefs: GuestMediaPrefs): void {
  write(local, MEDIA_KEY, JSON.stringify(prefs));
}

export function rememberedRequest(token: string): LiveGuestRequest | null {
  const raw = read(session, requestKey(token));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof LiveGuestRequest, unknown>>;
    return typeof value.requestId === "string" && typeof value.secret === "string" ? { requestId: value.requestId, secret: value.secret } : null;
  } catch {
    return null;
  }
}

export function rememberRequest(token: string, request: LiveGuestRequest | null): void {
  write(session, requestKey(token), request === null ? null : JSON.stringify(request));
}
