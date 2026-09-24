# Navigation exploration journey
1. Launch a newly built native app with a temporary profile; inspect initial browser chrome.
2. Enter a public URL via Cmd+L, browse a real page, follow a link and inspect back/forward/reload.
3. Enter a natural-language search and verify the resulting destination and rendering.
4. Visit a deterministic local browsing fixture; type into a form, follow a link, return, find repeated text and cycle matches.
5. Visit a refused localhost address to inspect error recovery, then recover through address entry.
6. Inspect site information, permission states, sound, zoom and downloads. Capture meaningful transitions and inspect captures visually.

UI input drives chrome. Fixture content is served by a local HTTP server (no mocked application backend); native WebContents content access, when required, is recorded explicitly.
