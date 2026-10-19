/**
 * What is behind the person on camera (docs/live-share.md §1): none, blur, a
 * few built-in scenes, or a picture of their own. The owner holds an upload
 * (an object URL it revokes when it is replaced), since the background is in
 * use long after this menu has closed.
 */

import { Ban, Droplet, ImagePlus } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import type { LiveBackground, LiveImageBackground } from "../effects.js";

export interface BackgroundMenuProps {
  value: LiveBackground;
  onChange(background: LiveBackground): void;
  /** The built-in scenes (`BUILTIN_BACKGROUNDS`). */
  backgrounds: readonly LiveImageBackground[];
  /** The person's own picture, once they have chosen one. */
  custom: LiveImageBackground | null;
  onUpload(file: File): void;
  /** False where this browser cannot run the effect; the choices are then off and say why. */
  supported: boolean;
}

function same(a: LiveBackground, b: LiveBackground): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "image" || (b.kind === "image" && a.url === b.url);
}

export function BackgroundMenu({ value, onChange, backgrounds, custom, onUpload, supported }: BackgroundMenuProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const images = custom === null ? backgrounds : [...backgrounds, custom];

  const tile = (background: LiveBackground, label: string, face: ReactNode, style?: CSSProperties) => (
    <button
      key={background.kind === "image" ? background.url : background.kind}
      type="button"
      role="menuitemradio"
      aria-checked={same(value, background)}
      aria-label={label}
      title={label}
      className="lv-bg-tile"
      data-kind={background.kind}
      style={style}
      disabled={!supported && background.kind !== "none"}
      onClick={() => onChange(background)}
    >
      {face}
    </button>
  );

  return (
    <div className="lv-menu-section" role="group" aria-label="Background">
      <div className="lv-menu-title">Background</div>
      <div className="lv-bg-grid">
        {tile({ kind: "none" }, "No background", <Ban aria-hidden="true" />)}
        {tile({ kind: "blur", strength: "strong" }, "Blur", <Droplet aria-hidden="true" />)}
        {images.map((image) => tile(image, image.label ?? "Your picture", null, { backgroundImage: `url("${image.url}")` }))}
        <button type="button" className="lv-bg-tile" data-kind="upload" aria-label="Upload a picture" title="Upload a picture" disabled={!supported} onClick={() => fileRef.current?.click()}>
          <ImagePlus aria-hidden="true" />
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file !== undefined) onUpload(file);
        }}
      />
      {supported ? null : <p className="lv-menu-note">This browser can&rsquo;t change your background.</p>}
    </div>
  );
}
