import { Ban, Droplets, Eraser, Highlighter, Mic, MicOff, Pen, Video, VideoOff, Zap } from "lucide-react";
import { LIVE_COLORS } from "@pistachio/live-share";
import { BUILTIN_BACKGROUNDS, supportsBackgroundProcessors } from "@pistachio/live-share/effects";
import type { LiveBackgroundChoice, LiveDeviceKind, LiveInkTool, LiveShareState } from "@pistachio/shell-contracts/live-share";
import { toggleLiveDrawing } from "../../lib/live/actions";
import { livePen, sendLive, setLivePen, useLiveShareStore } from "../../lib/live/store";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { LiveSection } from "./LiveShareTab";

/** The pen's colours: the host's own first, then the room's others, as guests' cursors wear them. */
const INK_COLORS: readonly string[] = LIVE_COLORS.slice(0, 6);

const TOOLS: ReadonlyArray<{ id: LiveInkTool; label: string; icon: React.ReactNode }> = [
  { id: "pen", label: "Pen", icon: <Pen aria-hidden="true" /> },
  { id: "highlighter", label: "Highlighter", icon: <Highlighter aria-hidden="true" /> },
  { id: "laser", label: "Laser", icon: <Zap aria-hidden="true" /> },
];

const DEVICE_KINDS: ReadonlyArray<{ kind: LiveDeviceKind; label: string }> = [
  { kind: "audioinput", label: "Microphone" },
  { kind: "videoinput", label: "Camera" },
  { kind: "audiooutput", label: "Speaker" },
];

/**
 * The host in the room: their mic and camera, the camera's background
 * (none, blur, the built-in scenes), the devices (as the live-host window
 * lists them: ids are its own), and the pen to draw over the desk with —
 * pen, highlighter or laser, a colour, Clear all.
 */
export function LiveYou({ state }: { state: LiveShareState }) {
  const local = state.local;
  return (
    <>
      <LiveSection label="You" testId="live-you">
        <div className="live-media-row">
          <Button
            variant="secondary"
            size="xs"
            aria-pressed={local.mic}
            data-testid="live-mic"
            data-on={local.mic ? "" : undefined}
            className="live-media-toggle"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void sendLive({ type: "setMic", on: !local.mic })}
          >
            {local.mic ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
            {local.mic ? "Mic on" : "Mic off"}
          </Button>
          <Button
            variant="secondary"
            size="xs"
            aria-pressed={local.camera}
            data-testid="live-camera"
            data-on={local.camera ? "" : undefined}
            className="live-media-toggle"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void sendLive({ type: "setCamera", on: !local.camera })}
          >
            {local.camera ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />}
            {local.camera ? "Camera on" : "Camera off"}
          </Button>
        </div>
        <Backgrounds value={local.background} />
        {state.devices.length === 0 ? null : (
          <div className="live-devices">
            {DEVICE_KINDS.map(({ kind, label }) => {
              const devices = state.devices.filter((device) => device.kind === kind);
              if (devices.length === 0) return null;
              return (
                <label key={kind} className="live-row">
                  <span className="live-row-label">{label}</span>
                  <Select
                    aria-label={label}
                    className="live-device-select"
                    value={local.devices[kind] ?? ""}
                    items={[{ value: "", label: "System default" }, ...devices.map((device) => ({ value: device.deviceId, label: device.label || label }))]}
                    onValueChange={(deviceId) => void sendLive({ type: "setDevice", kind, deviceId: deviceId === "" ? null : deviceId })}
                  />
                </label>
              );
            })}
          </div>
        )}
      </LiveSection>
      <LiveDraw drawing={state.drawing !== null} />
    </>
  );
}

/**
 * None, blur, and the built-in scenes, as swatches. (The effects module is
 * light: the segmenter's code loads in the live-host window, and only once a
 * background is put on a camera.) Where this Mac's graphics cannot run them,
 * the swatches are off and say why — this window's engine is the live-host
 * window's.
 */
function Backgrounds({ value }: { value: LiveBackgroundChoice }) {
  const supported = supportsBackgroundProcessors();
  const choose = (background: LiveBackgroundChoice): void => void sendLive({ type: "setBackground", background });
  const swatch = (key: string, label: string, selected: boolean, background: LiveBackgroundChoice, face: React.ReactNode, image?: string) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={supported ? label : `${label} — camera backgrounds need graphics this Mac doesn't offer`}
      disabled={!supported && background.kind !== "none"}
      data-testid={`live-background-${key}`}
      className="live-background"
      style={image === undefined ? undefined : { backgroundImage: `url("${image}")` }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => choose(background)}
    >
      {face}
    </button>
  );
  return (
    <div className="live-backgrounds" role="radiogroup" aria-label="Camera background">
      {swatch("none", "No background", value.kind === "none", { kind: "none" }, <Ban aria-hidden="true" />)}
      {swatch("blur", "Blur", value.kind === "blur", { kind: "blur" }, <Droplets aria-hidden="true" />)}
      {BUILTIN_BACKGROUNDS.map((scene) => swatch(scene.label ?? scene.url.slice(-8), scene.label ?? "Scene", value.kind === "image" && value.url === scene.url, scene, null, scene.url))}
    </div>
  );
}

/** The pen: its tool and colour, drawing on the desk or not, and Clear all. */
function LiveDraw({ drawing }: { drawing: boolean }) {
  const pen = useLiveShareStore((store) => store.pen);
  return (
    <LiveSection label="Draw" testId="live-draw">
      <div className="live-draw-row">
        <div className="desk-segmented" role="radiogroup" aria-label="Pen">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="radio"
              aria-checked={pen.tool === tool.id}
              aria-label={tool.label}
              title={tool.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setLivePen({ ...livePen(), tool: tool.id })}
            >
              {tool.icon}
            </button>
          ))}
        </div>
        <div className="live-ink-colors" role="radiogroup" aria-label="Colour">
          {INK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={pen.color === color}
              aria-label={color}
              className="live-ink-color"
              style={{ background: color }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setLivePen({ ...livePen(), color })}
            />
          ))}
        </div>
      </div>
      <div className="live-draw-row">
        <Button size="xs" data-testid="live-draw" aria-pressed={drawing} className="flex-1" onMouseDown={(event) => event.preventDefault()} onClick={toggleLiveDrawing}>
          {drawing ? "Stop drawing" : "Draw on the desk"}
        </Button>
        <Button variant="tertiary" size="xs" data-testid="live-clear-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => void sendLive({ type: "clearInk" })}>
          <Eraser aria-hidden="true" />
          Clear all
        </Button>
      </div>
    </LiveSection>
  );
}
