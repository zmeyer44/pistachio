/**
 * What a note's pages may do (docs/notes.md §8).
 *
 * Two documents leave this package to be served somewhere: the published
 * page a note becomes (`publish.ts`), and the document an HTML block runs
 * in (`nodes/html-document.ts`). Each runs a person's own widgets — scripts
 * on purpose — so each is served sandboxed, with an opaque origin, and may
 * reach the web for the things a widget is made of: a library from a CDN, a
 * font, a picture, a request. What neither may do is act as the site it was
 * served from: no same origin, no form submission, no navigation of the
 * page around it.
 *
 * One fact decides the shape of both. A frame made from `srcdoc` (or a
 * `data:` or `blob:` URL) inherits the policy of the page that holds it —
 * Chromium applies the parent's `script-src` to the child's inline scripts
 * — and `frame-src` never governs a `srcdoc` frame at all. So a published
 * page that holds widgets in `srcdoc` frames has to carry a policy those
 * widgets can live under, and a page whose own policy forbids inline
 * scripts (the desktop shell) cannot hold a widget in a `srcdoc` frame at
 * all: it serves each widget's document from an address of its own, under
 * `HTML_BLOCK_FRAME_CSP`, which the frame then has as a policy of its own.
 */

/** What a widget's document, or a page holding widgets, may fetch and run. */
const WIDGET_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https: http:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https: wss:",
  // Embeds (YouTube, Loom, Figma, …) are frames; a widget's `srcdoc` frames
  // are not governed by this and need nothing here.
  "frame-src https:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
] as const;

/**
 * The published page's policy, header form: the sandbox that gives the page
 * an opaque origin, what its widgets may do, and who may frame it.
 */
export const NOTE_PAGE_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  ...WIDGET_DIRECTIVES,
  "frame-ancestors 'self'",
].join("; ");

/**
 * The same policy for a `<meta http-equiv>` inside a `srcdoc` document: a
 * meta cannot carry `sandbox` or `frame-ancestors`, and the frame holding the
 * document supplies the sandbox with its own attribute.
 */
export const NOTE_PAGE_META_CSP = WIDGET_DIRECTIVES.join("; ");

/**
 * The policy a widget's document is served under when it has an address of
 * its own (the desktop's `pistachio-app://note-frame/`). The sandbox is in
 * the header as well as on the frame, so the address opened on its own is
 * no less opaque than it is inside a note.
 */
export const HTML_BLOCK_FRAME_CSP = ["sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox", ...WIDGET_DIRECTIVES].join("; ");
