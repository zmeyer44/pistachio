/**
 * The one stylesheet a published note carries, inline.
 *
 * It loads nothing of its own: no font file, no sheet. The page is served
 * under `NOTE_PAGE_CSP` (`csp.ts`), which lets the note's widgets and embeds
 * reach the web but has no reason to let the page's chrome do so, so the
 * typeface is named rather than shipped: Geist if the reader happens to have
 * it, the system's own face otherwise.
 */

export const NOTE_STYLESHEET = `
:root {
  color-scheme: light dark;
  --note-bg: #ffffff;
  --note-fg: #1a1a1a;
  --note-muted: #6b6b6b;
  --note-rule: rgba(0, 0, 0, 0.1);
  --note-fill: rgba(0, 0, 0, 0.05);
  --note-link: #2563eb;
  --note-callout: rgba(0, 0, 0, 0.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --note-bg: #111111;
    --note-fg: #ededed;
    --note-muted: #a1a1a1;
    --note-rule: rgba(255, 255, 255, 0.14);
    --note-fill: rgba(255, 255, 255, 0.07);
    --note-link: #7aa2f7;
    --note-callout: rgba(255, 255, 255, 0.05);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 48px 24px 96px;
  background: var(--note-bg);
  color: var(--note-fg);
  font-family: "Geist", "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 720px; margin: 0 auto; }
.note-title {
  margin: 0 0 32px;
  font-size: 40px;
  line-height: 1.15;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.note-icon { margin-right: 12px; }
.note-body > *:first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 {
  margin: 32px 0 12px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.02em;
}
h1 { font-size: 30px; }
h2 { font-size: 24px; }
h3 { font-size: 20px; }
h4, h5, h6 { font-size: 16px; }
p { margin: 0 0 16px; }
p:empty { min-height: 1.6em; }
a { color: var(--note-link); text-underline-offset: 2px; }
ul, ol { margin: 0 0 16px; padding-left: 24px; }
li { margin: 4px 0; }
li > p { margin: 0; }
li > ul, li > ol { margin-bottom: 0; }
ul.note-task-list { list-style: none; padding-left: 4px; }
ul.note-task-list > li { display: flex; align-items: flex-start; gap: 10px; }
ul.note-task-list > li > input[type="checkbox"] { margin: 7px 0 0; flex: none; }
ul.note-task-list > li > div { flex: 1; min-width: 0; }
ul.note-task-list > li[data-checked="true"] > div { color: var(--note-muted); text-decoration: line-through; }
hr { margin: 32px 0; border: 0; border-bottom: 1px solid var(--note-rule); }
blockquote {
  margin: 0 0 16px;
  padding-left: 16px;
  border-left: 2px solid var(--note-rule);
  color: var(--note-muted);
}
blockquote > p:last-child { margin-bottom: 0; }
code {
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.875em;
  background: var(--note-fill);
  border-radius: 4px;
  padding: 1px 4px;
}
pre {
  margin: 0 0 16px;
  padding: 16px;
  background: var(--note-fill);
  border-radius: 8px;
  overflow-x: auto;
}
pre code { background: none; border-radius: 0; padding: 0; font-size: 13px; }
table { width: 100%; margin: 0 0 16px; border-collapse: collapse; font-size: 15px; }
th, td { padding: 8px 12px; border: 1px solid var(--note-rule); text-align: left; vertical-align: top; }
th { background: var(--note-fill); font-weight: 600; }
td > p, th > p { margin: 0; }
img { max-width: 100%; height: auto; border-radius: 8px; }
.note-image-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  margin: 0 0 16px;
  padding: 16px;
  background: var(--note-fill);
  border-radius: 8px;
  color: var(--note-muted);
  font-size: 14px;
}
.note-callout {
  display: flex;
  gap: 10px;
  margin: 0 0 16px;
  padding: 14px 16px 14px 14px;
  border-radius: 8px;
  background: var(--note-callout);
}
.note-callout[data-emoji="⚠️"] { background: rgba(255, 163, 68, 0.13); }
.note-callout[data-emoji="❗"], .note-callout[data-emoji="❌"], .note-callout[data-emoji="🛑"] { background: rgba(255, 115, 105, 0.12); }
.note-callout[data-emoji="✅"] { background: rgba(77, 171, 154, 0.13); }
.note-callout[data-emoji="ℹ️"] { background: rgba(35, 131, 226, 0.09); }
.note-callout-emoji { flex: none; font-size: 18px; line-height: 1.45; }
.note-callout-body { flex: 1; min-width: 0; }
.note-callout-body > *:last-child { margin-bottom: 0; }
details { margin: 0 0 16px; }
summary { cursor: pointer; font-weight: 500; }
summary > p { display: inline; margin: 0; }
.note-toggle-body { padding: 8px 0 0 20px; }
.note-toggle-body > *:last-child { margin-bottom: 0; }
.note-embed { margin: 0 0 16px; }
.note-embed-frame {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 8px;
  background: var(--note-fill);
}
.note-embed[data-provider="Web"] .note-embed-frame { aspect-ratio: auto; height: 480px; }
.note-embed[data-provider="Figma"] .note-embed-frame { aspect-ratio: 16 / 10; }
.note-embed-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.note-embed-caption {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  color: inherit;
  font-size: 13px;
  text-decoration: none;
}
.note-embed-provider { font-size: 12px; font-weight: 500; color: var(--note-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.note-embed-url { color: var(--note-link); overflow-wrap: anywhere; }
.note-html-block { margin: 0 0 16px; }
.note-html-frame { display: block; width: 100%; border: 0; background: transparent; }
`.trim();
