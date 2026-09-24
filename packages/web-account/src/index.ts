/**
 * The account layer both web apps share (docs/web-browser-design.md §15).
 *
 * `apps/www` (the dashboard) and `apps/web` (the browser) sign in to the same
 * control plane, as the same kind of device, holding the same keys and reading
 * the same sealed records. That is one implementation, not two: everything
 * below is the seam between a browser tab and the account behind it, and the
 * only thing either app tells it apart with is the name it enrols under
 * (`deviceName`), because device keys live in the origin's IndexedDB and the
 * Devices page has to say which site is which.
 *
 * The gate ships with its own stylesheet (`@pistachio/web-account/auth.css`),
 * self-contained on purpose: the front door looks the same in both apps, and
 * the browser app never loads the marketing tokens the dashboard is built on.
 */

export * from "./artifacts";
export * from "./control";
export * from "./credential-vault";
export * from "./device";
export * from "./gate";
export * from "./idb";
export * from "./keys";
export * from "./live-view";
export * from "./notes";
export * from "./pin";
export * from "./pin-motion";
export * from "./pin-sound";
export * from "./records";
export * from "./runs";
export * from "./session";
export * from "./session-boundary";
export * from "./token";
export * from "./ui";
export * from "./usage";
export * from "./vault";
