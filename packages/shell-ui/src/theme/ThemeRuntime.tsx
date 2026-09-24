import { useEffect, useLayoutEffect, useState } from "react";
import { appearanceGradient, DEFAULT_APPEARANCE, type AppearanceSettings } from "@pistachio/shell-contracts/appearance";
import { shellApi } from "../api";

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const DESKTOP_GLASS_SUPPORTED = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Settings arrive as a fresh object on every push, whatever changed. Only an
 * appearance that differs in value gets to re-run applyAppearance, which
 * writes a couple of dozen properties onto <html> and restyles the window.
 */
function sameAppearance(a: AppearanceSettings, b: AppearanceSettings): boolean {
  if (a === b) return true;
  return (
    a.scheme === b.scheme &&
    a.desktopGlass === b.desktopGlass &&
    a.glassTint === b.glassTint &&
    a.gradientEnabled === b.gradientEnabled &&
    a.harmony === b.harmony &&
    a.blend === b.blend &&
    a.angle === b.angle &&
    a.intensity === b.intensity &&
    a.texture === b.texture &&
    a.contrast === b.contrast &&
    a.surfaceOpacity === b.surfaceOpacity &&
    a.radius === b.radius &&
    a.colors.length === b.colors.length &&
    a.colors.every((color, index) => color === b.colors[index])
  );
}

function applyAppearance(appearance: AppearanceSettings, prefersDark: boolean): void {
  const dark = appearance.scheme === "dark" || (appearance.scheme === "system" && prefersDark);
  const root = document.documentElement;
  const accent = appearance.colors[0] ?? DEFAULT_APPEARANCE.colors[0]!;
  const tint = Math.round(appearance.intensity * (dark ? 14 : 9));
  const contrast = Math.round(appearance.contrast * (dark ? 9 : 5));
  const raised = dark ? "#242629" : "#FFFFFF";
  const recessed = dark ? `hsl(220 5% ${13 + contrast / 2}%)` : `hsl(60 8% ${98 - contrast / 2}%)`;
  const radius = appearance.radius;

  root.dataset["colorScheme"] = dark ? "dark" : "light";
  root.dataset["desktopGlass"] = DESKTOP_GLASS_SUPPORTED && appearance.desktopGlass ? "on" : "off";
  // Two switches styles.css keys expensive paint on. The chrome's backdrop
  // blur only has something to blur when the surface lets the gradient
  // through, and the texture layer is only worth compositing when it has
  // any opacity at all.
  root.dataset["surfaceTranslucent"] = appearance.surfaceOpacity < 1 ? "on" : "off";
  root.dataset["texture"] = appearance.texture > 0 ? "on" : "off";
  // All three gradient colours, not just the primary: surfaces that sweep the
  // palette (the agent ring in styles.css) need the whole theme, and a theme
  // set to one or two colours repeats its last rather than falling to a
  // hard-coded hue.
  const [, second = accent, third = second] = appearance.colors;
  root.style.setProperty("--theme-accent", accent);
  root.style.setProperty("--theme-accent-2", second);
  root.style.setProperty("--theme-accent-3", third);
  root.style.setProperty("--theme-window-gradient", appearanceGradient(appearance));
  root.style.setProperty("--theme-glass-gradient", appearanceGradient(appearance, 0.25));
  root.style.setProperty("--theme-texture-opacity", String(appearance.texture * 0.14));
  root.style.setProperty("--theme-surface-opacity", String(appearance.surfaceOpacity));
  root.style.setProperty("--theme-surface-opacity-percent", `${Math.round(appearance.surfaceOpacity * 100)}%`);
  root.style.setProperty("--theme-glass-tint-opacity-percent", `${Math.round(appearance.glassTint * 100)}%`);
  root.style.setProperty("--color-background-100", `color-mix(in oklch, ${raised} ${100 - tint}%, ${accent})`);
  root.style.setProperty("--color-background-200", `color-mix(in oklch, ${recessed} ${100 - tint}%, ${accent})`);
  root.style.setProperty("--color-ring", accent);
  root.style.setProperty("--radius-xs", `${Math.max(2, Math.round(radius * 0.5))}px`);
  root.style.setProperty("--radius-sm", `${Math.max(3, Math.round(radius * 0.75))}px`);
  root.style.setProperty("--radius-md", `${radius}px`);
  root.style.setProperty("--radius-lg", `${Math.round(radius * 1.5)}px`);
}

/**
 * Every renderer page owns one of these. It deliberately listens to settings
 * directly instead of depending on the shell store, because find and drag
 * are tiny standalone renderer pages that otherwise have no settings state.
 */
export function ThemeRuntime() {
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [prefersDark, setPrefersDark] = useState(systemDark);

  useEffect(() => {
    let active = true;
    // Keep the previous object when nothing in it changed, so React bails
    // out and the layout effect below does not re-run for a settings push
    // about something else.
    const adopt = (next: AppearanceSettings) =>
      setAppearance((previous) => (sameAppearance(previous, next) ? previous : next));
    void shellApi().getSettings().then((settings) => {
      if (active) adopt(settings.appearance);
    });
    const off = shellApi().onSettings((settings) => adopt(settings.appearance));
    return () => {
      active = false;
      off();
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setPrefersDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => applyAppearance(appearance, prefersDark), [appearance, prefersDark]);
  return null;
}
