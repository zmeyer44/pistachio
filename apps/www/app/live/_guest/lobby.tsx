/**
 * The way in (docs/live-share.md §1 The guest): whose space it is, a name, the
 * camera as others will see it (mirrored, as a mirror is), the microphone's
 * level, the switches and their devices, a background — then *Ask to join*
 * (*Join* when anyone with the link may). Asking keeps this screen, with
 * the camera still up, and says who is being waited on.
 *
 * A camera or microphone the browser refuses never blocks the way in: the
 * note says what is missing and the button still joins, to listen or to
 * watch.
 */

import { CameraOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "@pistachio/live-share";
import {
  BackgroundMenu,
  chooseBackground,
  describeBackgroundProblem,
  describeCameraHold,
  describeMediaProblem,
  DeviceMenu,
  MediaButton,
  switchReadsOn,
  useDevices,
  useMediaSwitch,
  type GuestLobbyError,
  type LiveJoinInfo,
  type MediaProblem,
} from "@pistachio/live-share/react";
import { BUILTIN_BACKGROUNDS, supportsBackgroundProcessors } from "@pistachio/live-share/effects";
import type { LivePreview } from "@pistachio/live-share/room";
import type { GuestMedia } from "./guest-media";
import { BrandMark, DeskGlyph, GuestShell } from "./screens";

export interface LobbyProps {
  phase: "lobby" | "knocking" | "joining";
  share: LiveJoinInfo;
  preview: LivePreview;
  media: GuestMedia;
  name: string;
  onName(name: string): void;
  busy: boolean;
  error: GuestLobbyError | null;
  onJoin(name: string): void;
  onCancel(): void;
}

const ERRORS: Readonly<Record<GuestLobbyError, string>> = {
  name: `Enter a name of up to ${String(MAX_NAME_LENGTH)} characters.`,
  lobby_full: "Too many people are waiting to join right now. Try again in a moment.",
  rate_limited: "That was a lot of tries. Wait a moment and try again.",
  network: "Couldn’t reach Pistachio. Check your connection and try again.",
};

/** Previews whose camera and microphone were started: an effect run twice (React's strict mode) must not start two cameras. */
const started = new WeakSet<LivePreview>();

function initialOf(name: string): string {
  return [...name.trim()][0]?.toLocaleUpperCase() ?? "";
}

/** What the camera and microphone problems mean for joining, in one or two lines. */
function mediaNote(problems: { microphone: MediaProblem | null; camera: MediaProblem | null }): string | null {
  const mic = problems.microphone;
  const camera = problems.camera;
  if (mic !== null && camera !== null) {
    return mic === "blocked" && camera === "blocked"
      ? "Your browser blocked the camera and microphone. You can still join to watch, point and chat."
      : "Your camera and microphone aren’t available. You can still join to watch, point and chat.";
  }
  if (camera !== null) return `${describeMediaProblem("camera", camera)} You can still join with your microphone.`;
  if (mic !== null) return `${describeMediaProblem("microphone", mic)} You can still join; others won’t hear you.`;
  return null;
}

/** The preview's tracks as React state: re-render when one comes, goes or changes device. */
function usePreviewVersion(preview: LivePreview): number {
  const version = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      preview.onChange(() => {
        version.current += 1;
        notify();
      }),
    [preview],
  );
  return useSyncExternalStore(subscribe, () => version.current, () => 0);
}

function CameraPreview({ preview, media, name }: { preview: LivePreview; media: GuestMedia; name: string }) {
  usePreviewVersion(preview);
  const videoRef = useRef<HTMLVideoElement>(null);
  const switcher = useMediaSwitch(preview);
  const { set: setMedia, setOnOrDefault } = switcher;
  const camera = preview.camera();
  const micOn = preview.microphone() !== null;
  const cameraOn = camera !== null;
  // One coming on (its prompt, a camera's background loading) reads as on at its switch: turned off, it is stopped as it comes.
  const micSwitchOn = switchReadsOn(switcher, "microphone", micOn);
  const cameraSwitchOn = switchReadsOn(switcher, "camera", cameraOn);
  const microphones = useDevices("audioinput", micOn);
  const cameras = useDevices("videoinput", cameraOn);
  // Remembered once each took, over the choices as they stand then: one made meanwhile is kept.
  const { prefs, memory, background, onBackground, held } = media;
  const [backgroundNote, setBackgroundNote] = useState<string | null>(null);

  // The camera and microphone as last time, once per preview. A device that is gone falls back to the default, which is then
  // the one remembered. A background remembered that cannot be put back (their own picture, not kept) holds the camera off,
  // and the note says so.
  useEffect(() => {
    if (started.has(preview)) return;
    started.add(preview);
    const initial = memory.current();
    if (initial.camera && memory.held() === null && preview.camera() === null) void memory.resume(setOnOrDefault, "camera");
    if (initial.microphone && preview.microphone() === null) void memory.resume(setOnOrDefault, "microphone");
  }, [preview, setOnOrDefault, memory]);

  // What is behind the person follows the choice (and is in place before the camera is handed to the room). One
  // that cannot be put on leaves the camera behind the one it had: the menu says that one again, and the note why.
  useEffect(() => {
    if (preview.background() === background) return;
    setBackgroundNote(null);
    chooseBackground(preview, background, (shown, problem) => {
      onBackground(shown);
      setBackgroundNote(describeBackgroundProblem(problem));
    });
  }, [preview, background, onBackground]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || camera === null) return;
    camera.attach(video);
    return () => {
      camera.detach(video);
    };
  }, [camera]);

  const level = useCallback(() => preview.micLevel(), [preview]);

  const toggle = (kind: "microphone" | "camera"): void => {
    void memory.switch(setMedia, kind, kind === "microphone" ? !micSwitchOn : !cameraSwitchOn);
  };

  const choose = (kind: "audioinput" | "videoinput", deviceId: string): void => {
    void setMedia(kind === "audioinput" ? "microphone" : "camera", true, deviceId).then((outcome) => {
      if (outcome === "done") memory.remember(kind === "audioinput" ? { audioinput: deviceId, microphone: true } : { videoinput: deviceId, camera: true });
    });
  };

  // Why a switch did not come on, for the switch to say too: it stays a click from trying again.
  const problemNote = (kind: "microphone" | "camera"): string | null => {
    const said = switcher.problem[kind];
    return said === null ? null : describeMediaProblem(kind, said);
  };
  const heldNote = held === null || cameraSwitchOn ? null : describeCameraHold(held);
  const note = [mediaNote(switcher.problem), heldNote, backgroundNote].filter((line) => line !== null).join(" ") || null;

  return (
    <div className="lvg-preview-wrap">
      <div className="lvg-preview" data-camera={cameraOn ? "" : undefined}>
        <div className="lvg-preview-screen">
          <video ref={videoRef} className="lvg-preview-video" muted playsInline autoPlay hidden={!cameraOn} />
          {cameraOn ? null : (
            <div className="lvg-preview-off">
              {name.trim() === "" ? <CameraOff aria-hidden="true" className="lvg-preview-off-icon" /> : <span className="lvg-preview-initial">{initialOf(name)}</span>}
              <span className="lvg-preview-off-text">{switcher.busy.camera ? "Starting camera…" : "Camera is off"}</span>
            </div>
          )}
          {name.trim() === "" ? null : <span className="lvg-preview-name">{name.trim()}</span>}
        </div>
        <div className="lvg-preview-controls">
          <MediaButton
            kind="microphone"
            variant="overlay"
            on={micSwitchOn}
            busy={switcher.busy.microphone}
            problem={problemNote("microphone")}
            onToggle={() => toggle("microphone")}
            level={level}
            menu={<DeviceMenu title="Microphone" devices={microphones} selected={prefs.audioinput} onSelect={(id) => choose("audioinput", id)} />}
          />
          <MediaButton
            kind="camera"
            variant="overlay"
            on={cameraSwitchOn}
            busy={switcher.busy.camera}
            problem={problemNote("camera")}
            onToggle={() => toggle("camera")}
            menu={
              <>
                <DeviceMenu title="Camera" devices={cameras} selected={prefs.videoinput} onSelect={(id) => choose("videoinput", id)} />
                <BackgroundMenu
                  value={background}
                  onChange={media.onBackground}
                  backgrounds={BUILTIN_BACKGROUNDS}
                  custom={media.custom}
                  onUpload={(file) => media.onBackground(media.onUpload(file))}
                  supported={supportsBackgroundProcessors()}
                />
              </>
            }
          />
        </div>
      </div>
      {note === null ? null : (
        <p className="lvg-preview-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export function Lobby({ phase, share, preview, media, name, onName, busy, error, onJoin, onCancel }: LobbyProps) {
  const host = share.hostName ?? "The host";
  const inputRef = useRef<HTMLInputElement>(null);
  const waiting = phase === "knocking";
  const joining = phase === "joining" || busy;

  useEffect(() => {
    if (phase === "lobby" && name === "") inputRef.current?.focus();
  }, [phase, name]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!joining) onJoin(name);
  };

  return (
    <GuestShell screen={phase}>
      <header className="lvg-topbar">
        <BrandMark />
      </header>
      <main className="lvg-lobby">
        <CameraPreview preview={preview} media={media} name={name} />
        <section className="lvg-lobby-panel" data-phase={phase} aria-live="polite">
          <DeskGlyph state={waiting ? "waiting" : "lobby"} host={share.hostName ?? "Host"} guestInitial={initialOf(name)} />
          {waiting ? (
            <div className="lvg-lobby-copy" key="waiting">
              <p className="lvg-eyebrow">
                <span className="lvg-pulse" aria-hidden="true" />
                Asked to join
              </p>
              <h1 className="lvg-title">Waiting for {share.hostName ?? "the host"} to let you in</h1>
              <p className="lvg-lede">
                {host === "The host" ? "They’ll" : `${host} will`} see “{name}” asking to join <em>{share.title}</em>.
              </p>
              <button type="button" className="lvg-button" data-variant="secondary" onClick={onCancel}>
                Cancel
              </button>
            </div>
          ) : (
            <form className="lvg-lobby-copy" key="form" onSubmit={submit} noValidate>
              <p className="lvg-eyebrow">
                <span className="lvg-live-dot" aria-hidden="true" />
                {host} is sharing
              </p>
              <h1 className="lvg-title">{share.title}</h1>
              <p className="lvg-lede">Join to see the windows of this space live, point and draw on them, and talk.</p>
              <label className="lvg-field">
                <span className="lvg-field-label">Your name</span>
                <input
                  ref={inputRef}
                  className="lvg-input"
                  name="name"
                  autoComplete="name"
                  maxLength={MAX_NAME_LENGTH * 2}
                  value={name}
                  placeholder="How others will see you"
                  aria-invalid={error === "name" ? true : undefined}
                  disabled={joining}
                  onChange={(event) => onName(event.currentTarget.value)}
                />
              </label>
              <button type="submit" className="lvg-button" data-variant="primary" disabled={joining || name.trim() === ""} data-busy={joining ? "" : undefined}>
                {joining ? (share.admission === "open" || phase === "joining" ? "Joining…" : "Asking…") : share.admission === "open" ? "Join" : "Ask to join"}
              </button>
              {error === null ? null : (
                <p className="lvg-error" role="alert">
                  {ERRORS[error]}
                </p>
              )}
              <p className="lvg-fine">You’ll see every window in this space as {host} moves through it. Everyone in the share sees your name.</p>
            </form>
          )}
        </section>
      </main>
    </GuestShell>
  );
}
