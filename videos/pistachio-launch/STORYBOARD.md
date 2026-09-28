---
format: 1920x1080
duration: 53s
message: "Pistachio is a Mac browser with an agent built in — ask in plain words and it gets it done, inside the tabs you're already signed in to."
arc: Future Pacing with a Demo Loop core — imagine → name product → show it working → why you can trust it → everyday moves → trust → CTA
audience: Mac users who live in their browser — builders, knowledge workers, early adopters
mode: autonomous
music: original synthesized bed, 120 BPM, D major, warm plucks + soft pads + four-on-the-floor from 6s; built locally (assets/audio/bgm.wav)
tempo: 120 BPM — 1 beat = 0.5s, 1 bar = 2.0s. Every frame boundary sits on a bar line; every reveal sits on a beat.
---

# Pistachio — launch film

This video tells **Mac users who live in their browser** that **Pistachio is a browser with an agent built in: ask in plain words and it gets the job done, inside the tabs you're already signed in to — every step shown, and you stay in control.**

No narration. The on-screen copy IS the script; each frame's `copy` lists its lines and the beat each lands on. Reveals are paced to those cues and the 120 BPM grid (not to a voice).

## Video direction

**Palette (frame.md, PISTACHIO OVERRIDES win).** Canvas white `#FFFFFF` for type beats; paper `#FAFAFA`; ink `#1A1A1A`; muted `#6B6B6B`; pistachio green `#52A862` is the ONE accent (key word per line, buttons, step badges, agent highlight); deep green `#3F8F4F`; moss `#0F2E16` is the only dark ground (Frame 6); field `#E8F4EC` tints. The green wave wallpaper (`assets/hero-wallpaper-pistachio.jpg`) is the signature world the product lives in (Frames 2, 3, 5). macOS traffic-light colors only on window chrome.

**Type.** Inter only (fonts staged in `assets/fonts/`, @font-face in frame.md). Display = Inter 400, sentence case, tight negative tracking (≈ −0.045em at 120px+, −0.04em at 80px). Never bold display, never uppercase display. UI text inside the product at realistic macOS sizes scaled for 1080p legibility (≥ 20px).

**Motion grammar.** macOS-soft and precise: `power3.out` / `expo.out` entrances, 0.5–0.9s, small travel (24–60px) + opacity + blur-to-sharp (10px→0) on type; windows enter with scale 0.96→1 and a gentle rise. Per-word staggered rises for headlines (`dynamic-content-sequencing`). No bounce, no elastic overshoot beyond a hair, no spin, no glitch, no chromatic effects. All motion in one paused GSAP timeline per frame, `fromTo` entrances, deterministic.

**Reveal model.** Nothing appears before its cue. The cues are the `copy` beats listed per frame on the 120 BPM grid.

**Rhythm / held frames.** Frame 1 staccato (a line per beat pair) → Frame 2 the first big release (beat drop at 6.0s) → Frame 3 the long, calm demo (the breather where the product speaks; holds after each step) → Frame 4 punchy triad → Frame 5 bar-by-bar feature cycle → Frame 6 held, dark, quiet build → Frame 7 release + held end card. Held reads: end of Frame 3 (25–28s), Frame 6 (45–46s), Frame 7 (50–53s).

**Negative list.** No purple/blue "AI" gradients, no sparkles/particles, no neon glows, no emoji, no exclamation marks, no fake metrics, no competitor names, no scrollbars. Neither failure mode: no slideshow (front-load then freeze), no screensaver (everything floating independently). No lazy breathing loops, no slow back-half push on held content.

## Frame 1 — Forty tabs

- scene: Staccato kinetic type on white — the everyday browser grind stacks up line by line while a tab strip of real favicons multiplies across the top, then clears to the question.
- voiceover: ""
- copy: 0.0 "Forty tabs." · 1.0 "Twelve logins." · 2.0 "Every one of them waiting on you." · 3.5 (clear) "What if your browser" · 4.5 "could do the work?" ("do the work" in green)
- duration: 6s
- poster: 5.4
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- type: hook
- persuasion: Pain validation → future pacing
- beat: overwhelm → curiosity
- blueprint: kinetic-type-beats (Adapt)
- asset_candidates: assets/favicons/x.png — X favicon; assets/favicons/youtube.png — YouTube favicon; assets/favicons/google.png — Google favicon; assets/favicons/google-calendar.png — Calendar favicon; assets/favicons/github.png — GitHub favicon; assets/favicons/wikipedia.png — Wikipedia favicon; assets/favicons/chatgpt.png — ChatGPT favicon; assets/favicons/claude.png — Claude favicon
- focal: the type itself
- roles: favicons = supporting (tab-strip props, small, top band)
- sfx: key-press on 0.0 / 1.0 / 2.0; whoosh-short at 3.5

narrativeRole: open on the viewer's own reality — too many tabs, too many chores — then flip to the promise in one breath.
keyMessage: your browser makes you do all the work.

Adapt: keep kinetic-type-beats' signature (a statement builds across beats onto a payoff line); add a thin, real-looking macOS tab strip along the top band that fills with favicon tabs as the lines land.
Scene 1 (0.0–1.0s): White canvas. Left-aligned at the left third, vertically centered: "Forty tabs." rises per-word, blur-to-sharp, ink, display ~120px. Along the top band a slim glassy tab strip (pill tabs with favicon + short grey title) begins filling: 8 tabs slide in from the right on a tight stagger.
Scene 2 (1.0–2.0s): "Twelve logins." enters below on the beat; the previous line dims to muted grey. Tab strip keeps accumulating (tabs compress narrower as more arrive — 20 tabs).
Scene 3 (2.0–3.5s): "Every one of them waiting on you." enters as the third line (display ~84px); earlier lines dim further; the tab strip is now crammed (40 tabs, favicons only, squeezed) — the visual of overload. Hold for the read.
Scene 4 (3.5–4.5s): Hard clear on the beat: all lines and the strip vanish (instant cut, `discrete-text-sequence`). Centered: "What if your browser" rises per-word, display ~110px.
Scene 5 (4.5–6.0s): Second line "could do the work?" rises below; "do the work" is pistachio green. Hold still to the cut at 6.0.
- handoff_out: none (clean cut into Frame 2's white canvas; Frame 2 starts white).

## Frame 2 — Meet Pistachio

- scene: On the beat drop, the green wave wallpaper blooms out of a rounded card at center to full-bleed; the Pistachio mark and wordmark assemble on it, then the tagline.
- voiceover: ""
- copy: 6.5 mark + "Pistachio" · 8.0 "A browser built for tomorrow." · 9.5 chip "Early preview for macOS" · 10.0 "With an agent built in."
- duration: 6s
- poster: 4.5
- transition_in: cut
- status: animated
- src: compositions/frames/02-intro.html
- type: product_intro
- persuasion: Category announcement
- beat: intrigue → aspiration
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/hero-wallpaper-pistachio.jpg — signature green wave wallpaper; assets/pistachio-mark.svg — app icon, white shell on green tile; assets/pistachio-glyph.svg — bare shell glyph (currentColor)
- focal: assets/pistachio-mark.svg
- roles: hero-wallpaper-pistachio = background (full-bleed, NOT dimmed — it is the brand world); pistachio-mark = cutout (hero lockup); pistachio-glyph = supporting (optional ghost echo)
- sfx: impact-bass-1 at 0.0; pop at 0.5; whoosh-short at 3.5

narrativeRole: name the product and its category at the moment of release.
keyMessage: Pistachio — a browser built for tomorrow, with an agent built in.

Adapt: keep the lockup's signature (the mark comes to exist on a cleared stage and resolves into a centered lockup); the stage itself is born first — the site's rounded hero card grows into the full frame.
Scene 1 (0.0–0.6s): White canvas. A small rounded-corner card (radius ~28px, ~30% width) holding the wallpaper appears at center and expands on `expo.out` to full-bleed (radius → 0). The wallpaper inside counter-scales from 1.25 → 1.06 so the waves feel like they unfold.
Scene 2 (0.5–2.0s): The green app mark (rounded tile, white shell glyph) springs in at center (`spring-pop-entrance`, smooth settle, tiny overshoot at most) ~150px, then slides left as the white wordmark "Pistachio" (Inter 500, ~150px, tight tracking) wipes in from behind it to its right — the pair forms one centered lockup in the upper-middle of the frame.
Scene 3 (2.0–3.5s): Under the lockup, "A browser built for tomorrow." rises per-word in white (display ~76px) — `dynamic-content-sequencing`.
Scene 4 (3.5–4.0s): A pill chip "Early preview for macOS" (1px white-60% outline, white text, pill) fades up above the lockup.
Scene 5 (4.0–6.0s): Below the tagline, "With an agent built in." fades up in field green `#E8F4EC` at ~40px. Hold still. Wallpaper drifts imperceptibly (scale 1.06 → 1.0 across the whole frame, linear-ish) so its END state is scale 1.0, centered, object-fit cover.
- handoff_out: wallpaper — full-bleed, centered, object-fit cover, scale 1.0, x 0, y 0, opacity 1, static at the cut. Lockup/text leave via the crossfade into Frame 3.

## Frame 3 — Just ask

- scene: A Pistachio window floats on the wallpaper with an inbox open; ⌘I opens the agent panel, a plain-words request types in, and the agent does it — opening, replying, archiving — each step listed live. Ends on "Inside the tabs you're already signed in to."
- voiceover: ""
- copy: 1.5 keycaps "⌘ I" · 2.5–5.5 typed prompt "Reply to the top email saying I'll be ten minutes late, then archive it." · 6.0 step "01 Opened the top email" · 8.5 step "02 Typed the reply" · 11.0 step "03 Sent it and archived the thread" · 13.0 "It works inside the tabs" · 13.5 "you're already signed in to."
- duration: 16s
- poster: 12.0
- transition_in: crossfade 0.5s
- status: animated
- src: compositions/frames/03-demo.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: curiosity → ease → control
- blueprint: prompt-type-submit-generate (Adapt)
- asset_candidates: assets/hero-wallpaper-pistachio.jpg — signature wallpaper the window floats on; assets/feature-agent.jpg — real screenshot of the agent panel, a REFERENCE for rebuilding the panel UI, never shown as a flat image; assets/pistachio-glyph.svg — shell glyph for the panel avatar and home favicon; assets/favicons/x.png — pinned tile; assets/favicons/youtube.png — pinned tile; assets/favicons/google.png — pinned tile; assets/favicons/google-calendar.png — pinned tile; assets/favicons/chatgpt.png — pinned tile; assets/favicons/claude.png — pinned tile
- focal: the rebuilt Pistachio window (HTML), agent panel on the right
- roles: hero-wallpaper-pistachio = background (full-bleed, undimmed); feature-agent = reference only (build UI in HTML to match it); favicons = supporting (sidebar pinned-tile grid); pistachio-glyph = supporting
- sfx: click at 1.5; typing at 2.5 (3s); click at 5.5; pop at 6.0; typing at 8.7 (1.5s); pop at 8.5; pop at 11.0; whoosh-short at 11.6; chime at 12.2

narrativeRole: prove the promise — plain words in, a real chore done, inside a signed-in tab, with every step visible.
keyMessage: ask in plain words; it does the work in your own tabs and shows each step.

The receipt borrows agent-progress-theater: rows arrive and check off while the machine visibly works.

UI build (HTML reconstruction, crisp at 1080p — match the real Pistachio shell in feature-agent.jpg and the site hero):
- Window ~1560×900, radius 16px, centered on the wallpaper, soft long shadow. Left sidebar ~300px of translucent green glass (`rgba(232,244,236,.55)`, backdrop blur): traffic lights (12px dots) + back/forward/reload glyphs; a URL field "mail.google.com" in a mono-ish small grey; a 3×2 grid of pinned tiles (the favicons on light tiles, radius 10px); "+ New tab"; "Live tabs" label; tab rows: "Inbox (3)" (active, white pill, with a small generic envelope glyph), "Pistachio – Wikipedia" (wikipedia favicon), "GitHub" (github favicon).
- Main pane (white, radius 12px, inset ~8px): a clean generic mail app (no Gmail branding — a neutral "Inbox" header, search field, rows). Rows (sender bold · subject · snippet grey · time right): 1) "Maya Chen — Standup moved to 9:30 · Can everyone still make it? …  8:52 AM" (unread dot green), 2) "Linear — 3 issues assigned to you · 8:10 AM", 3) "Jonah Park — Q4 roadmap draft · Left comments on section 2 … Yesterday", 4) "Figma — Maya invited you to 'Launch deck' · Yesterday", 5) "Stripe — Your weekly summary · Mon".
- Agent panel (right, ~430px, white/paper, opens inside the window pushing the pane narrower): header shell-glyph avatar + "Pistachio" + small "Ready" / "Working…" status; empty state "What can I do in your browser?" (display 400, ~34px); composer at bottom (rounded 14px, 1px border) placeholder "Ask Pistachio to do anything in your browser…".
- After send: the user message sits as a right-aligned bubble (paper tint); below it a "Steps" card styled like the site's OG card: label "Steps so far" left, "3 actions" right (counter ticks 1→2→3), rows with a small square badge "01/02/03" (green tile, white mono-ish numerals) + text; each row lands with a green check that draws on.
- The agent's focus: a soft green outline highlight (2px `#52A862`, radius 8px, faint green fill 8%) that glides onto whatever element the agent is acting on — the "agent cursor". No mouse pointer.

Scene 1 (0.0–1.5s): Wallpaper full-bleed (continuous from Frame 2). The window rises into place (y +60 → 0, scale 0.96 → 1, opacity 0 → 1, `power3.out`) showing the inbox; sidebar glass visible over the wallpaper.
Scene 2 (1.5–2.5s): Two floating macOS keycaps "⌘" and "I" (white, radius 14px, soft shadow, ~96px) pop in over the lower-center of the window and press down; on the press the agent panel slides in from the right edge of the window and the mail pane narrows in sync (`anchored-layout-expand`). Keycaps fade away as the panel lands. Status "Ready".
Scene 3 (2.5–5.5s): The camera eases in toward the panel (~1.25×, focus on the panel's lower half) while the prompt types into the composer with a caret: "Reply to the top email saying I'll be ten minutes late, then archive it." (`discrete-text-sequence` type-on with caret).
Scene 4 (5.5–6.0s): Send button presses; the prompt lifts into a user bubble at the top of the panel; status flips to "Working…" with a small green pulsing dot (finite). Camera eases back out to show the whole window (~1.0×).
Scene 5 (6.0–8.5s): Steps card appears under the bubble. Row "01 Opened the top email" lands (checks on). In the pane, the green agent highlight glides onto the top row (Maya Chen), then the pane swaps to the open email view: subject "Standup moved to 9:30", sender line, two lines of body text, and a reply box below.
Scene 6 (8.5–11.0s): Row "02 Typed the reply" lands. Highlight glides to the reply box; text types in: "Running about ten minutes late — start without me, I'll catch up." Counter "2 actions".
Scene 7 (11.0–13.0s): Row "03 Sent it and archived the thread" lands; highlight hits "Send" (tiny press), the view returns to the inbox, and the Maya Chen row collapses out (height → 0, others slide up); a small dark toast "Conversation archived" rises bottom-center of the pane. Status returns to "Ready" with a green check. Counter "3 actions".
Scene 8 (13.0–16.0s): The window glides right and scales to ~0.78, opening the left ~35% of the frame over the darker part of the wallpaper; there, left-aligned white display type (~72px, Inter 400) rises per-word: "It works inside the tabs" / "you're already signed in to." with "signed in" in field green `#E8F4EC`… (keep contrast: white on the dark wallpaper; add a very soft dark radial behind the text only if needed for contrast). Hold still from 14.5s to the end.
- handoff_in: wallpaper — full-bleed, centered, object-fit cover, scale 1.0, x 0, y 0, opacity 1, static (identical to Frame 2's end state).

## Frame 4 — You stay in control

- scene: Punchy white-canvas triad — three short lines slam in on consecutive beats with a tiny live UI proof next to each.
- voiceover: ""
- copy: 0.0 "Uses the sessions you already have." · 1.0 "Lists every step as it happens." · 2.0 "Start typing, and it stops." (the "stops" in green)
- duration: 4s
- poster: 3.2
- transition_in: zoom-through
- status: animated
- src: compositions/frames/04-control.html
- type: benefit_highlight
- persuasion: Rule of three + risk reversal
- beat: trust → control
- blueprint: kinetic-type-beats (Adapt)
- asset_candidates: assets/pistachio-glyph.svg — shell glyph for the status chip
- focal: the three lines
- roles: pistachio-glyph = supporting
- sfx: key-press at 0.0; key-press at 1.0; key-press at 2.0; click-soft at 2.6

narrativeRole: answer the natural worry ("will it go rogue?") with the three facts the site states — your sessions, every step shown, typing interrupts it.
keyMessage: it's your browser, and you're in charge.

Adapt: keep the kinetic beat-slam signature (`kinetic-beat-slam`: short phrases land on a shared percussive beat array, resolving on a locked finale); each line pairs with a small UI chip at its right that proves it.
Scene 1 (0.0–1.0s): White. Left-aligned column (left margin ~180px), line 1 "Uses the sessions you already have." rises (display ~72px, ink) with a leading light numeral "01" in green-muted; at its right end, a small chip shows three stacked favicon-less account pills "Signed in" with green dots.
Scene 2 (1.0–2.0s): Line 2 "Lists every step as it happens." lands below with "02"; its chip is a mini Steps list whose three rows tick in quickly.
Scene 3 (2.0–4.0s): Line 3 "Start typing, and it stops." lands with "03" ("stops" in green `#52A862`); its chip is a mini composer where a caret types "wait—" and the status pill flips from "Working…" (green pulsing dot) to "Paused" (grey) at 2.6s. Earlier lines stay ink (not dimmed — the triad reads as one list). Hold still to the cut.

## Frame 5 — Everyday moves, built in

- scene: The site's numbered feature run as a bar-by-bar cycle — a big light numeral and title on the left swap in place while the window on the right swaps to the real screenshot of each move.
- voiceover: ""
- copy: 0.0 "And the everyday moves," · 0.8 "built in around it." · 2.0 "02 Glance at a link" / "Peek, then pick up where you were." · 4.0 "03 Split the window" / "Two pages side by side, saved as a pair." · 6.0 "04 Read without the clutter" / "Just the words, on your type." · 8.0 "05 Media follows you" / "Keeps playing from the sidebar."
- duration: 10s
- poster: 5.0
- transition_in: crossfade 0.4s
- status: animated
- src: compositions/frames/05-moves.html
- type: feature_showcase
- persuasion: Value stacking
- beat: ease → delight
- blueprint: fixed-anchor-cycle (Adapt)
- asset_candidates: assets/feature-glance.jpg — real Glance screenshot; assets/feature-split.jpg — real Split screenshot; assets/feature-reader.jpg — real Reader screenshot; assets/feature-media-stack.jpg — real Media screenshot; assets/hero-wallpaper-pistachio.jpg — wallpaper behind the window
- focal: the window cycling the four real screenshots
- roles: feature-* = cutout (inside a rounded window frame, shown at ≤1.1× native — ~1060px wide); hero-wallpaper-pistachio = background (inside a large rounded panel on the right, like the site's feature section)
- sfx: whoosh-short at 2.0; whoosh-short at 4.0; whoosh-short at 6.0; whoosh-short at 8.0

narrativeRole: widen from the agent to the whole browser — it's a great browser day to day, not just a chatbot.
keyMessage: the everyday moves are built in too.

Adapt: keep fixed-anchor-cycle's signature (a fixed anchor holds while one slot cycles through values); the anchor is the left text column + the right window frame; the cycling slots are the numeral (in-place token cycle, `vertical-spring-ticker` roll 02→03→04→05, smooth, no bounce), the title/sub, and the screenshot.
Scene 1 (0.0–2.0s): White/paper canvas. Centered two-line headline rises per-word: "And the everyday moves," / "built in around it." (display ~88px, ink; "built in" green).
Scene 2 (2.0–4.0s): The headline slides up & out as the layout arrives (`scale-swap-transition`): right ~58% a large rounded panel (radius 24px) of the wallpaper with a window frame inside it (radius 14px, traffic lights strip) showing feature-glance.jpg; left column: huge light numeral "02" (Inter 300-400, ~200px, ink), title "Glance at a link" (~56px), sub "Peek, then pick up where you were." (~30px, muted).
Scene 3 (4.0–6.0s): Numeral rolls to "03"; title/sub swap (outgoing up-and-out, incoming up-and-in, blur-to-sharp); screenshot swaps to feature-split.jpg with a short horizontal push inside the window.
Scene 4 (6.0–8.0s): "04" · "Read without the clutter" · "Just the words, on your type." · feature-reader.jpg.
Scene 5 (8.0–10.0s): "05" · "Media follows you" · "Keeps playing from the sidebar." · feature-media-stack.jpg. Hold to the cut.

## Frame 6 — Yours

- scene: Moss-green ground; three trust statements land one per beat, then hold in quiet.
- voiceover: ""
- copy: 0.0 "Open source." (sub "GPL-3.0") · 1.0 "Local by default." · 2.0 "Runs on your Mac." (sub "Apple silicon")
- duration: 4s
- poster: 3.0
- transition_in: blur-crossfade
- status: animated
- src: compositions/frames/06-trust.html
- type: benefit_highlight
- persuasion: Risk reversal
- beat: trust → peace of mind
- blueprint: kinetic-type-beats (Adapt)
- asset_candidates: assets/pistachio-glyph.svg — faint oversized shell glyph watermark
- focal: the three statements
- roles: pistachio-glyph = background (huge, ~6% opacity, bottom-right, cropped)
- sfx: impact-bass-2 at 0.0; riser at 2.0

narrativeRole: the closing reassurance — you own it, it stays with you.
keyMessage: open source, local by default, on your Mac.

Adapt: triptych version of the kinetic beat-slam — three columns across the frame.
Scene 1 (0.0–1.0s): Moss `#0F2E16` full-bleed with a very subtle radial lift of deep green `#1c4a26` at center. Left column: "Open source." (white, display ~84px) rises blur-to-sharp; thin 1px field-green rule above it draws left→right; sub "GPL-3.0" small in green `#52A862`.
Scene 2 (1.0–2.0s): Middle column: "Local by default." same treatment.
Scene 3 (2.0–4.0s): Right column: "Runs on your Mac." + sub "Apple silicon". The oversized shell-glyph watermark fades up to 6% bottom-right. Hold still — the riser in the music carries tension into the outro.

## Frame 7 — A browser built for tomorrow

- scene: Release into a pistachio-green field; the giant white "Pistachio" wordmark rises from the bottom like the site's footer, the tagline and a Download button land, and it holds.
- voiceover: ""
- copy: 0.0 wordmark "Pistachio" · 1.5 "A browser built for tomorrow." · 2.5 button "Download for Mac →" + "pistachio.run" · 3.2 "Early preview · macOS on Apple silicon"
- duration: 7s
- poster: 5.0
- transition_in: cut
- status: animated
- src: compositions/frames/07-outro.html
- type: cta
- persuasion: Future pacing + friction reduction
- beat: triumph → urgency-to-act
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/pistachio-mark.svg — app icon; assets/pistachio-glyph.svg — shell glyph
- focal: the giant wordmark
- roles: pistachio-mark = supporting (small, beside the URL); pistachio-glyph = supporting
- sfx: impact-bass-1 at 0.0; pop at 2.5

narrativeRole: brand payoff + the one next step.
keyMessage: Pistachio. Download it for your Mac at pistachio.run.

Adapt: keep the lockup signature (the brand mark comes to exist and resolves into a held lockup); here the wordmark is the site's footer: enormous white "Pistachio" (Inter 500, ~420px, tracking −0.05em) whose baseline sits low in the frame.
Scene 1 (0.0–1.2s): Cut to full-bleed pistachio green `#52A862`. The giant white wordmark rises from below the bottom edge into place (clip-mask reveal per letter, fast stagger, `expo.out`), occupying the lower-middle band (baseline ~78% down, fully inside the frame).
Scene 2 (1.5–2.5s): Above it, top-left aligned to the wordmark's left edge: "A browser built for tomorrow." rises per-word (white, ~64px).
Scene 3 (2.5–3.5s): Top-right: a white button (radius 8px, green `#3F8F4F` text "Download for Mac  →", ~30px) pops in (`press-release-spring` settle), with "pistachio.run" (white 80%, ~28px) beside/below it and the small app mark tile beside it.
Scene 4 (3.2–6.4s): Small line "Early preview · macOS on Apple silicon" fades in under the tagline (white 75%). Hold still.
Scene 5 (6.4–7.0s): Final exit: everything fades to the green field (the film ends on clean green).
