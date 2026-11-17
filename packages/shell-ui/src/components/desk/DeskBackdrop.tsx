import { useState } from "react";
import type { ExtensionBackdrop } from "@pistachio/shell-contracts/extensions";
import { backdropKey, backdropScrim, backdropStyle, scopeOf } from "../../lib/extensions/shown";

/**
 * A backdrop in the desk's well (docs/primitives.md §4): what an extension's
 * theme put behind a space's windows — a colour, a gradient, a picture main
 * holds — drawn by the shell and never by the extension. It lies under
 * everything on the desk, in the well's own box and with the well's own hole
 * for the Bar's nub (the engine's --desk-notch-clip), so the nub, the
 * surface's gutter and the glass under them are the shell's ground as they
 * always are; the well's pressed-in edge is drawn over the picture, so a
 * well it stays.
 *
 * Two layers, one on: when the backdrop in force changes — the desk passes
 * to another space, an extension sets one, the person removes it — the other
 * layer takes the new picture and the two cross-fade (200 ms, the card
 * wash's; cut with reduced motion, in CSS). The same backdrop under two
 * spaces (one set for every space) is one picture: nothing fades.
 *
 * It takes no pointer: a press between the windows is the desk's own.
 */
export function DeskBackdrop({ backdrop }: { backdrop: ExtensionBackdrop | null }) {
  const key = backdropKey(backdrop);
  const [state, setState] = useState<{ key: string; layers: [ExtensionBackdrop | null, ExtensionBackdrop | null]; on: 0 | 1 | null }>(() => ({
    key,
    layers: [backdrop, null],
    on: backdrop === null ? null : 0,
  }));
  let shown = state;
  if (state.key !== key) {
    // (Derived from what main says is in force, as it changes: the layer that is off takes the new one, and comes on.)
    if (backdrop === null) shown = { ...state, key, on: null };
    else {
      const next: 0 | 1 = state.on === 0 ? 1 : 0;
      const layers: [ExtensionBackdrop | null, ExtensionBackdrop | null] = [state.layers[0], state.layers[1]];
      layers[next] = backdrop;
      shown = { key, layers, on: next };
    }
    setState(shown);
  }
  return (
    <div className="desk-backdrop" aria-hidden="true">
      {shown.layers.map((layer, index) => {
        const on = shown.on === index && layer !== null;
        const scrim = layer === null ? null : backdropScrim(layer.dim);
        return (
          <div
            key={index}
            className="desk-backdrop-layer"
            data-on={on ? "" : undefined}
            // (Only the one in force answers to the name: a layer fading out is a picture on its way off.)
            data-testid={on ? "desk-backdrop" : undefined}
            data-kind={on ? layer.value.kind : undefined}
            data-extension-id={on ? layer.extensionId : undefined}
            data-space-id={on ? scopeOf(layer.spaceId) : undefined}
            style={layer === null ? undefined : backdropStyle(layer.value)}
          >
            {scrim === null ? null : <span className="desk-backdrop-scrim" style={{ backgroundColor: scrim }} />}
          </div>
        );
      })}
    </div>
  );
}
