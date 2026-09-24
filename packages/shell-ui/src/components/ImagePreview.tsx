/**
 * The console's image lightbox — a thumbnail's expand button opens the full
 * picture here at reading size.
 *
 * Deliberately not shaped like SpaceForkDialog: that chrome (title row, fixed
 * width, body padding) is built for form-shaped content, and a picture wants
 * the opposite — size to the image, dark veil, click-anywhere-to-dismiss. It
 * still opens through the `overlay` union, which is what makes main raise the
 * chrome above the tab views; without that it would open UNDER the page.
 */

import { useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../store";
import { Button } from "./ui/button";

export function ImagePreview() {
  const preview = useAppStore((state) => state.imagePreview);
  const close = useAppStore((state) => state.closeImagePreview);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  if (preview === null) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={preview.alt === "" ? "Image preview" : preview.alt}
      data-testid="image-preview"
      // The veil spans the hole so ANY click outside the picture dismisses;
      // the figure stops propagation to stay clickable.
      onClick={close}
      className="animate-backdrop-in absolute inset-0 z-30 grid place-items-center rounded-md bg-[oklch(0_0_0/0.52)] p-10"
    >
      <figure
        onClick={(event) => event.stopPropagation()}
        className="relative flex max-h-full max-w-full flex-col items-center gap-2"
      >
        <img
          src={preview.src}
          alt={preview.alt}
          draggable={false}
          className="max-h-[82vh] min-h-0 max-w-full rounded-lg bg-background-100 object-contain shadow-[0_24px_80px_oklch(0_0_0/0.28),0_0_0_1px_var(--color-alpha-400)]"
        />
        {preview.alt === "" ? null : (
          <figcaption className="max-w-[70vw] truncate rounded-full bg-background-100 px-3 py-1 text-label-12 text-gray-900 shadow-border">
            {preview.alt}
          </figcaption>
        )}
        <Button
          variant="secondary"
          size="xs"
          svgOnly
          shape="circle"
          title="Close preview (Esc)"
          aria-label="Close preview"
          onClick={close}
          className="absolute -top-2.5 -right-2.5"
        >
          <X aria-hidden="true" />
        </Button>
      </figure>
    </div>
  );
}
