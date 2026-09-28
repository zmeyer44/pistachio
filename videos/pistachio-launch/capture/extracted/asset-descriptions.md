# Asset Descriptions

One line per file. Read this instead of opening every image individually.

To find a specific brand or icon, **grep this file for the brand name in the description text** (e.g. `grep -i 'autodesk' asset-descriptions.md`). The Gemini Vision captions identify what's actually in each file — that's the agent's selector.

The `logo-<hash>.svg` filename prefix is a cheap structural hint (DOM said this SVG was inside a `<header>`, home-link `<a>`, or had an aria-label matching the page brand). It is NOT a content claim — many `logo-*` files are nav icons or decorative shapes. Trust the captions, not the filename prefix.

- a-browser-that-pulls-its-weight.jpg — 172KB, This image features abstract, flowing green waves against a light background.
- are-you-ready-yet.webp — 156KB, A vintage computer sits on a wooden desk in a sunlit room with dark blue walls and green furniture.
- favicon.svg — 0KB, The image features a white abstract geometric icon resembling a stylized crown or letter "M" centered on a rounded-square green background.
- icon-icon-any.svg — 0KB, A white stylized "M" icon centered inside a green rounded-square container.
- og-image.png — 76KB, This website image features a light-colored background with dark green text and interface elements, showcasing a browser with a built-in AI agent.
- svgs/logo-5cbef975.svg — This is a simple black right-pointing arrow icon on a white background.
- svgs/svg-5cbef975-2.svg — This is a simple black arrow icon pointing toward the right.
- svgs/svg-5cbef975-3.svg — A bold black right-pointing arrow icon against a white background.
- svgs/svg-5cbef975.svg — A black, right-pointing arrow icon on a transparent background.
- svgs/svg-ad53402f.svg — This horizontal, rounded gray container features five square icons—representing a circle, a horizontal double-dash, a green abstract shape, a square, and a triangle—positioned against a dark background with a downward-pointing arrow above them.
- svgs/svg-bcbb7850.svg — This is a black, three-lined hamburger menu icon centered on a white background.
- fonts/19cfc7226ec3afaa-s.woff2 — font file
- fonts/21350d82a1f187e9-s.woff2 — font file
- fonts/8e9860b6e62d6359-s.woff2 — font file
- fonts/ba9851c3c22cd980-s.woff2 — font file
- fonts/c5fe6dc8356a8c31-s.woff2 — font file
- fonts/df0a9ae256c0569c-s.woff2 — font file

## Added from the Pistachio site source (apps/www/public) — same assets pistachio.run serves

- hero-wallpaper-pistachio.jpg — 1586x992, the signature pistachio-green flowing-wave wallpaper the site's hero browser floats on (dark moss lower-left → pale cream-yellow glow upper-right).
- pistachio-mark.svg — the app icon: white pistachio-shell glyph on a #52A862 rounded square (rx 18/64).
- pistachio-glyph.svg — the bare shell glyph, fill=currentColor, for tinting (white on green, green on white).
- feature-agent.jpg — 1024x710 real screenshot: Pistachio window with glass sidebar, a Vercel page in the pane, and the agent chat panel on the right ("What can I do in your browser?", suggestion rows, composer "Ask Pistachio to do anything in your browser…").
- feature-glance.jpg — 1024x710 real screenshot: Glance — a link opened as a floating card over the current page.
- feature-split.jpg — 1024x710 real screenshot: Split view — two pages side by side (calendar + page).
- feature-reader.jpg — 1024x710 real screenshot: Reader view — an article ("Why pistachio trees take turns") stripped to the words.
- feature-media-stack.jpg — 1024x710 real screenshot: Media follows you — YouTube playing, media card stack at the bottom of the sidebar.
- favicons/x.png, favicons/youtube.png, favicons/google.png, favicons/google-calendar.png, favicons/chatgpt.png, favicons/claude.png, favicons/github.png, favicons/wikipedia.png — the pinned-tile favicons the site's hero browser shows.
