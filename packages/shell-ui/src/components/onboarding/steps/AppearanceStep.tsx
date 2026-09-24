import { Monitor, Moon, Sun } from "lucide-react";
import { type AppearanceScheme } from "@pistachio/shell-contracts/appearance";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store";
import { AppearancePresets, DESKTOP_GLASS_SUPPORTED, ThemePreview } from "../../settings/ThemePreview";
import { Slider } from "../../ui/slider";
import { Switch } from "../../ui/switch";

const SCHEMES: ReadonlyArray<{ id: AppearanceScheme; label: string; icon: typeof Sun }> = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

/**
 * The appearance step's stage: the same preview and presets Settings →
 * Appearance uses, writing straight to the settings file — the window
 * behind the wizard takes each change as it is made, and fades in already
 * wearing it.
 */
export function AppearanceStep() {
  const appearance = useAppStore((state) => state.settings.appearance);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const update = (patch: Parameters<typeof updateSettings>[0]["appearance"]) => void updateSettings({ appearance: patch });
  return (
    <div className="onboarding-stage flex w-full max-w-[600px] flex-col gap-5" data-testid="onboarding-appearance">
      <ThemePreview appearance={appearance} className="h-60 shadow-modal" />
      <section className="rounded-[18px] bg-background-100 p-5 shadow-modal">
        <p className="mb-3 text-label-13 font-medium text-gray-1000">Presets</p>
        <AppearancePresets appearance={appearance} onSelect={(patch) => update(patch)} />
        <div className="mt-5 grid grid-cols-[1fr_auto] items-center gap-4">
          <div role="radiogroup" aria-label="Color mode" className="grid grid-cols-3 gap-1.5 rounded-md bg-alpha-100 p-1">
            {SCHEMES.map(({ id, label, icon: Icon }) => {
              const selected = appearance.scheme === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`onboarding-scheme-${id}`}
                  onClick={() => update({ scheme: id })}
                  className={cn(
                    "flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-sm text-label-13 outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "bg-background-100 text-gray-1000 shadow-small" : "text-gray-900 hover:text-gray-1000",
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2.5 text-label-13 text-gray-1000">
            <span>Desktop glass</span>
            <Switch
              checked={DESKTOP_GLASS_SUPPORTED && appearance.desktopGlass}
              onChange={(desktopGlass) => update({ desktopGlass })}
              label="Desktop glass"
              disabled={!DESKTOP_GLASS_SUPPORTED}
            />
          </label>
        </div>
        <div className="mt-3">
          <Slider label="Corners" value={appearance.radius} min={0} max={18} suffix="px" onChange={(radius) => update({ radius })} />
        </div>
      </section>
    </div>
  );
}
