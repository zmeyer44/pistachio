/**
 * The mini browser window Settings → Appearance paints its live preview
 * into, and the onboarding wizard's appearance step borrows: a sidebar, a
 * page card, and the palette's dots, all drawn from the same appearance
 * the real window is about to take. `appearanceGradient` is the exact
 * paint the window uses, so what the card shows is what lands.
 */

import { Check } from "lucide-react";
import { APPEARANCE_PRESETS, appearanceGradient, type AppearanceSettings } from "@pistachio/shell-contracts/appearance";
import { cn } from "../../lib/cn";

export const DESKTOP_GLASS_SUPPORTED = /Mac|iPhone|iPad/.test(navigator.platform);

export function ThemePreview({ appearance, className }: { appearance: AppearanceSettings; className?: string }) {
  const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = appearance.scheme === "dark" || (appearance.scheme === "system" && systemIsDark);
  const glass = DESKTOP_GLASS_SUPPORTED && appearance.desktopGlass;
  const previewSurfaceOpacity = glass ? appearance.glassTint : appearance.surfaceOpacity;
  const desktopBackdrop = dark
    ? "radial-gradient(circle at 16% 82%, #5b5f86 0%, transparent 34%), radial-gradient(circle at 82% 12%, #87666f 0%, transparent 31%), linear-gradient(145deg, #29303a, #15181d)"
    : "radial-gradient(circle at 18% 82%, #9bc8c2 0%, transparent 35%), radial-gradient(circle at 82% 12%, #d7b4c8 0%, transparent 33%), linear-gradient(145deg, #dce5e5, #b8c5d4)";
  return (
    <div
      data-testid="appearance-preview"
      className={cn("relative h-44 overflow-hidden border border-alpha-400 shadow-small transition-[border-radius,background] duration-200", className)}
      style={{
        borderRadius: Math.max(6, appearance.radius + 4),
        color: dark ? "#f4f4f5" : "#252629",
        backgroundColor: dark ? "#17191c" : "#f4f5f2",
        backgroundImage: glass ? desktopBackdrop : appearanceGradient(appearance),
      }}
    >
      {glass ? (
        <span className="absolute top-2 right-2 z-10 rounded-full border border-white/20 bg-black/25 px-2 py-0.5 text-[9px] font-medium tracking-wide text-white uppercase backdrop-blur-md">
          Desktop glass
        </span>
      ) : null}
      <div className="absolute inset-0 flex">
        <div
          className="w-27 border-r border-white/12 p-3 backdrop-blur-xl"
          style={{
            backgroundColor: dark ? `rgb(27 29 32 / ${previewSurfaceOpacity})` : `rgb(255 255 255 / ${previewSurfaceOpacity})`,
            backgroundImage: appearanceGradient(appearance, glass ? 0.25 : 1),
            backgroundBlendMode: "soft-light",
            ...(glass
              ? {
                  WebkitBackdropFilter: "blur(36px) saturate(1.3)",
                  backdropFilter: "blur(36px) saturate(1.3)",
                }
              : {}),
          }}
        >
          <div className="mb-5 flex gap-1.5 opacity-55">
            <span className="size-2 rounded-full bg-[#ff6159]" />
            <span className="size-2 rounded-full bg-[#ffbd2e]" />
            <span className="size-2 rounded-full bg-[#28c940]" />
          </div>
          {[46, 64, 52, 70].map((width, index) => (
            <div
              key={width}
              className={cn("mb-2 h-2 rounded-full", index === 1 ? "bg-white/45" : "bg-current opacity-15")}
              style={{ width }}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2">
            <span className="h-3 w-16 rounded-full bg-current opacity-22" />
            <span className="h-3 w-12 rounded-full bg-current opacity-10" />
          </div>
          <div
            className="min-h-0 flex-1 border border-white/10 shadow-[0_8px_30px_rgb(0_0_0/0.08)] backdrop-blur-xl"
            style={{
              borderRadius: appearance.radius,
              background: dark ? "rgb(35 37 40 / 0.97)" : "rgb(255 255 255 / 0.97)",
            }}
          >
            <div className="flex h-8 items-center gap-1.5 border-b border-current/10 px-3">
              {appearance.colors.map((color, index) => (
                <span key={`${color}-${index}`} className="size-2 rounded-full" style={{ backgroundColor: color }} />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 p-3">
              <span className="h-13 rounded-md bg-current opacity-[0.07]" />
              <span className="h-13 rounded-md bg-current opacity-[0.1]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The preset tiles: five palettes as gradient swatches, the current one
 * ringed. Selecting one hands back the appearance fields it sets; colours
 * are copied so a later edit never writes into the preset itself.
 */
export function AppearancePresets({
  appearance,
  onSelect,
}: {
  appearance: AppearanceSettings;
  onSelect: (patch: Partial<AppearanceSettings>) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {APPEARANCE_PRESETS.map((preset) => {
        const selected = preset.colors.join() === appearance.colors.join() && preset.blend === appearance.blend;
        return (
          <button
            key={preset.id}
            type="button"
            title={preset.label}
            aria-label={`Use ${preset.label} theme`}
            aria-pressed={selected}
            data-testid={`appearance-preset-${preset.id}`}
            onClick={() =>
              onSelect({
                gradientEnabled: true,
                colors: [...preset.colors],
                harmony: preset.harmony,
                blend: preset.blend,
                angle: preset.angle,
                intensity: preset.intensity,
                texture: preset.texture,
              })
            }
            className={cn(
              "group relative aspect-square cursor-pointer overflow-hidden rounded-md outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              selected ? "shadow-[0_0_0_1.5px_var(--color-gray-1000)]" : "shadow-border",
            )}
            style={{
              backgroundColor: "#25272a",
              backgroundImage: appearanceGradient({ ...appearance, ...preset, gradientEnabled: true }),
            }}
          >
            <span className="absolute right-1.5 bottom-1.5 left-1.5 truncate rounded-full bg-black/35 px-1.5 py-0.5 text-center text-[9px] font-medium text-white backdrop-blur-sm">
              {preset.label}
            </span>
            {selected ? <Check className="absolute top-1.5 right-1.5 size-3.5 text-white drop-shadow" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
