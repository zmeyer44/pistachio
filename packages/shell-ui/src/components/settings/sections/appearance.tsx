import { PistachioMark } from "../../PistachioMark";
import { Monitor, Moon, Plus, RotateCcw, Sun, X } from "lucide-react";
import {
  colorsForHarmony,
  DEFAULT_APPEARANCE,
  type AppearanceScheme,
  type AppearanceSettings,
  type GradientBlend,
  type GradientHarmony,
} from "@pistachio/shell-contracts/appearance";
import { NOTICE_POSITIONS, noticeAlign, noticeEdge, type NoticePosition } from "@pistachio/shell-contracts/notice";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store";
import { Button } from "../../ui/button";
import { Select } from "../../ui/select";
import { Slider } from "../../ui/slider";
import { Switch } from "../../ui/switch";
import { Block, Group, Page, Row } from "../parts";
import { AppearancePresets, DESKTOP_GLASS_SUPPORTED, ThemePreview } from "../ThemePreview";
import { copyFor } from "../../../lib/surface-copy";
import { useSurface } from "../../../surface";

const SCHEMES: ReadonlyArray<{ id: AppearanceScheme; label: string; icon: typeof Sun }> = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

const HARMONIES: ReadonlyArray<{ value: GradientHarmony; label: string }> = [
  { value: "complementary", label: "Complementary" },
  { value: "singleAnalogous", label: "Analogous pair" },
  { value: "splitComplementary", label: "Split complementary" },
  { value: "analogous", label: "Analogous trio" },
  { value: "triadic", label: "Triadic" },
  { value: "floating", label: "Freeform" },
];

const BLENDS: ReadonlyArray<{ value: GradientBlend; label: string }> = [
  { value: "mesh", label: "Mesh" },
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
];
const POSITION_LABELS: Record<NoticePosition, string> = {
  "top-left": "Top left corner",
  top: "Top",
  "top-right": "Top right corner",
  "bottom-left": "Bottom left corner",
  bottom: "Bottom",
  "bottom-right": "Bottom right corner",
};

/**
 * Where the notice stack stands (@pistachio/shell-contracts/notice): a
 * small page with a pill at each of the six places one can go, so the
 * choice is made on a picture of the thing it moves.
 */
function ToastPositionPicker({ value, onChange }: { value: NoticePosition; onChange(position: NoticePosition): void }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div
        role="radiogroup"
        aria-label="Notification position"
        data-testid="toast-position"
        className="relative h-28 w-52 shrink-0 rounded-md bg-background-200 shadow-border"
      >
        {NOTICE_POSITIONS.map((position) => {
          const selected = position === value;
          const align = noticeAlign(position);
          return (
            <button
              key={position}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={POSITION_LABELS[position]}
              title={POSITION_LABELS[position]}
              data-testid={`toast-position-${position}`}
              onClick={() => onChange(position)}
              className={cn(
                "group absolute grid h-8 w-16 cursor-pointer place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                noticeEdge(position) === "top" ? "top-1" : "bottom-1",
                align === "left" ? "left-1" : align === "right" ? "right-1" : "left-1/2 -translate-x-1/2",
              )}
            >
              <span
                className={cn(
                  "h-3 w-12 rounded-full transition-[background-color,transform] duration-150",
                  selected ? "scale-100 bg-gray-1000" : "scale-90 bg-alpha-300 group-hover:bg-alpha-500",
                )}
              />
            </button>
          );
        })}
      </div>
      <span className="text-label-13 text-gray-900">{POSITION_LABELS[value]}</span>
    </div>
  );
}

export function AppearancePage() {
  const appearance = useAppStore((state) => state.settings.appearance);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const showNotice = useAppStore((state) => state.showNotice);
  const surface = useSurface();
  const copy = copyFor(surface.kind).appearance;
  const update = (patch: Partial<AppearanceSettings>) => void updateSettings({ appearance: patch });

  const changeColor = (index: number, color: string) => {
    if (index === 0 && appearance.harmony !== "floating") {
      update({ colors: colorsForHarmony(color, appearance.harmony, appearance.colors) });
      return;
    }
    const colors = appearance.colors.map((current, candidate) => (candidate === index ? color.toUpperCase() : current));
    update({ colors, ...(index === 0 ? {} : { harmony: "floating" as const }) });
  };

  return (
    <Page
      title="Appearance"
      description={copy.description}
    >
      <ThemePreview appearance={appearance} />

      <Group title="Theme" note="The scheme the window follows, and the material it is painted with.">
        <Block label="Color mode" note={copy.colorMode}>
          <div role="radiogroup" aria-label="Color mode" className="grid grid-cols-3 gap-2">
            {SCHEMES.map(({ id, label, icon: Icon }) => {
              const selected = appearance.scheme === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => update({ scheme: id })}
                  className={cn(
                    "flex h-9 cursor-pointer items-center justify-center gap-2 rounded-sm text-label-13 outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    selected
                      ? "bg-gray-1000 text-background-100"
                      : "bg-background-100 text-gray-900 shadow-border hover:text-gray-1000 hover:shadow-[0_0_0_1px_var(--color-gray-500)]",
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        </Block>
        <Row label="Gradient material" note="Paint the window chrome with the selected palette.">
          <Switch
            checked={appearance.gradientEnabled}
            onChange={(gradientEnabled) => update({ gradientEnabled })}
            label="Gradient material"
          />
        </Row>
        <Row
          label="Desktop glass"
          note={
            DESKTOP_GLASS_SUPPORTED ? copy.desktopGlass : copy.desktopGlassUnsupported
          }
        >
          <Switch
            checked={DESKTOP_GLASS_SUPPORTED && appearance.desktopGlass}
            onChange={(desktopGlass) => update({ desktopGlass })}
            label="Desktop glass"
            disabled={!DESKTOP_GLASS_SUPPORTED}
          />
        </Row>
        <Block label="Corner radius" note="Applies across panels, cards, and browser panes.">
          <Slider
            label="Corners"
            value={appearance.radius}
            min={0}
            max={18}
            suffix="px"
            onChange={(radius) => update({ radius })}
          />
        </Block>
      </Group>

      {surface.kind === "native" ? (
        <Group title="App icon" note="Choose the icon shown in your Dock or taskbar. Changes apply immediately.">
          <Block>
            <div className="flex gap-3" data-testid="desktop-icon-picker">
              {(["white", "green"] as const).map((variant) => (
                <label
                  key={variant}
                  data-testid={`desktop-icon-option-${variant}`}
                  data-selected={appearance.desktopIcon === variant}
                  className={cn(
                    "relative flex w-32 cursor-pointer flex-col items-center gap-3 rounded-md border p-4 text-label-13 transition-colors focus-within:ring-2 focus-within:ring-ring",
                    appearance.desktopIcon === variant
                      ? "border-gray-1000 bg-background-200 text-gray-1000"
                      : "border-gray-400 bg-background-100 text-gray-900 hover:border-gray-700",
                  )}
                >
                  <input
                    type="radio"
                    name="desktop-icon"
                    value={variant}
                    checked={appearance.desktopIcon === variant}
                    onChange={() => update({ desktopIcon: variant })}
                    className="sr-only"
                    data-testid={`desktop-icon-${variant}`}
                  />
                  <span className="rounded-[14px] shadow-border">
                    <PistachioMark size={48} variant={variant} desktopIcon />
                  </span>
                  <span>{variant === "white" ? "White" : "Green"}</span>
                </label>
              ))}
            </div>
          </Block>
        </Group>
      ) : null}

      <Group title="Notifications" note="The brief confirmations that appear over the page, like “URL copied”.">
        <Block label="Position" note="Notifications enter from this edge of the page and stack away from it.">
          <ToastPositionPicker
            value={appearance.toastPosition}
            onChange={(toastPosition) => {
              update({ toastPosition });
              // Shown where it will be from now on: the choice is its own preview.
              showNotice("Notifications appear here", { tone: "success" });
            }}
          />
        </Block>
      </Group>

      <Group title="Presets" note="A starting point — every value below remains editable.">
        <Block>
          <AppearancePresets appearance={appearance} onSelect={(patch) => update(patch)} />
        </Block>
      </Group>

      <Group title="Palette" note="Up to three stops. Editing a linked secondary color switches the harmony to Freeform.">
        <Block label="Gradient colors">
          <div className="flex flex-wrap items-center gap-2">
            {appearance.colors.map((color, index) => (
              <div key={index} className="flex items-center gap-1 rounded-sm bg-background-200 p-1 shadow-border">
                <label
                  className="relative grid size-7 cursor-pointer place-items-center overflow-hidden rounded-xs shadow-border"
                  style={{ backgroundColor: color }}
                >
                  <span className="sr-only">Color {index + 1}</span>
                  <input
                    type="color"
                    data-testid={`appearance-color-${index}`}
                    value={color}
                    onChange={(event) => changeColor(index, event.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
                <span className="w-15 px-1 font-mono text-[10px] text-gray-900">{color}</span>
                {appearance.colors.length === 1 ? null : (
                  <button
                    type="button"
                    aria-label={`Remove color ${index + 1}`}
                    onClick={() =>
                      update({
                        colors: appearance.colors.filter((_, candidate) => candidate !== index),
                        harmony: "floating",
                      })
                    }
                    className="grid size-6 cursor-pointer place-items-center rounded-xs text-gray-700 hover:bg-alpha-200 hover:text-gray-1000"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            {appearance.colors.length >= 3 ? null : (
              <Button
                variant="secondary"
                size="sm"
                prefix={<Plus aria-hidden="true" />}
                onClick={() => {
                  const candidates = colorsForHarmony(appearance.colors[0]!, "triadic");
                  update({
                    colors: [...appearance.colors, candidates[appearance.colors.length] ?? "#A8B3C7"],
                    harmony: "floating",
                  });
                }}
              >
                Add color
              </Button>
            )}
          </div>
        </Block>
        <Row label="Color harmony" note="Linked harmonies regenerate from the first color.">
          <Select
            aria-label="Color harmony"
            value={appearance.harmony}
            items={HARMONIES}
            onValueChange={(harmony) =>
              update({ harmony, colors: colorsForHarmony(appearance.colors[0]!, harmony, appearance.colors) })
            }
            className="w-44"
          />
        </Row>
        <Row label="Blend" note="Mesh layers radial light over a directional wash.">
          <Select
            aria-label="Blend"
            value={appearance.blend}
            items={BLENDS}
            onValueChange={(blend) => update({ blend })}
            className="w-32"
          />
        </Row>
      </Group>

      <Group
        title="Material"
        note="How the gradient is cast across the chrome, and how much of the surface it reaches."
        footer={copy.materialFooter}
        footerAction={
          <Button
            variant="secondary"
            size="sm"
            prefix={<RotateCcw />}
            onClick={() => update({ ...DEFAULT_APPEARANCE, colors: [...DEFAULT_APPEARANCE.colors] })}
          >
            Restore defaults
          </Button>
        }
      >
        <Block>
          <Slider label="Direction" value={appearance.angle} min={0} max={359} suffix="°" onChange={(angle) => update({ angle })} />
          <Slider
            label="Intensity"
            value={Math.round(appearance.intensity * 100)}
            onChange={(intensity) => update({ intensity: intensity / 100 })}
          />
          <Slider
            label="Texture"
            value={Math.round(appearance.texture * 100)}
            onChange={(texture) => update({ texture: texture / 100 })}
          />
          <Slider
            label="Contrast"
            value={Math.round(appearance.contrast * 100)}
            onChange={(contrast) => update({ contrast: contrast / 100 })}
          />
          <Slider
            label={appearance.desktopGlass ? "Glass tint" : "Surface"}
            value={Math.round((appearance.desktopGlass ? appearance.glassTint : appearance.surfaceOpacity) * 100)}
            min={appearance.desktopGlass ? 25 : 55}
            max={100}
            onChange={(value) =>
              update(appearance.desktopGlass ? { glassTint: value / 100 } : { surfaceOpacity: value / 100 })
            }
          />
        </Block>
      </Group>
    </Page>
  );
}
