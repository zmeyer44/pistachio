/** A small element builder and the editor's icons (plain DOM, no library). */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((event: never) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") {
      el.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    } else if (name === "class") {
      el.className = String(value);
    } else if (name in el && typeof (el as unknown as Record<string, unknown>)[name] !== "string" && typeof value !== "string") {
      (el as unknown as Record<string, unknown>)[name] = value;
    } else {
      el.setAttribute(name, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child);
  }
}

const SVG = "http://www.w3.org/2000/svg";

/** A 16px stroke icon from path data. */
export function icon(paths: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  // A path written "!…" is filled rather than stroked.
  for (const d of paths.split("|")) {
    const path = document.createElementNS(SVG, "path");
    const filled = d.startsWith("!");
    path.setAttribute("d", filled ? d.slice(1) : d);
    if (filled) {
      path.setAttribute("fill", "currentColor");
      path.setAttribute("stroke", "none");
    }
    svg.append(path);
  }
  return svg;
}

export const ICONS = {
  back: "M10 3 5 8l5 5",
  undo: "M4.5 6.5h5.25a3.25 3.25 0 0 1 0 6.5H6|M7 4 4.5 6.5 7 9",
  redo: "M11.5 6.5H6.25a3.25 3.25 0 0 0 0 6.5H10|M9 4l2.5 2.5L9 9",
  play: "!M5 3.2v9.6a.5.5 0 0 0 .76.43l7.6-4.8a.5.5 0 0 0 0-.86l-7.6-4.8A.5.5 0 0 0 5 3.2Z",
  pause: "!M4.5 3h2.2v10H4.5Z|!M9.3 3h2.2v10H9.3Z",
  rewind: "!M8 4 3 8l5 4Z|!M14 4 9 8l5 4Z",
  forward: "!M8 4l5 4-5 4Z|!M2 4l5 4-5 4Z",
  eye: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8|M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
  scissors: "M5 5.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5|M5 14a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5|M6.3 4.9 13.5 12|M6.3 11.1 13.5 4",
  close: "M4 4l8 8|M12 4l-8 8",
  copy: "M5.5 5.5h7v7h-7z|M3.5 10.5v-7h7",
  folder: "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z",
  note: "M4 2.5h5.5L12 5v8.5H4z|M9.5 2.5V5H12|M6 8h4|M6 10.5h4",
  zoom: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10|M10.6 10.6 14 14|M5 7h4|M7 5v4",
  speed: "M2.5 4.5 7 8l-4.5 3.5|M8.5 4.5 13 8l-4.5 3.5",
  trash: "M3 4.5h10|M6 4.5V3h4v1.5|M4.5 4.5l.6 8.5h5.8l.6-8.5",
};
