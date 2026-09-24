/**
 * The one stylesheet a published note carries, inline.
 *
 * It loads nothing: no font file, no sheet, no script. That is not taste —
 * `ARTIFACT_CSP` (apps/desktop/src/main/artifact-store.ts) serves a hosted
 * page under `default-src 'none'` with only `data:` images and inline styles
 * allowed, so anything fetched would simply not arrive. The typeface is
 * therefore named rather than shipped: Geist if the reader happens to have it,
 * the system's own face otherwise.
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
}
@media (prefers-color-scheme: dark) {
  :root {
    --note-bg: #111111;
    --note-fg: #ededed;
    --note-muted: #a1a1a1;
    --note-rule: rgba(255, 255, 255, 0.14);
    --note-fill: rgba(255, 255, 255, 0.07);
    --note-link: #7aa2f7;
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
a { color: var(--note-link); text-underline-offset: 2px; }
ul, ol { margin: 0 0 16px; padding-left: 24px; }
li { margin: 4px 0; }
li > ul, li > ol { margin-bottom: 0; }
ul.contains-task-list { list-style: none; padding-left: 4px; }
ul.contains-task-list input[type="checkbox"] { margin-right: 8px; }
hr { margin: 32px 0; border: 0; border-bottom: 1px solid var(--note-rule); }
blockquote {
  margin: 0 0 16px;
  padding-left: 16px;
  border-left: 2px solid var(--note-rule);
  color: var(--note-muted);
}
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
th, td { padding: 8px 12px; border: 1px solid var(--note-rule); text-align: left; }
th { background: var(--note-fill); font-weight: 600; }
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
`.trim();
