# Soft stack implementation

Implemented in `/Users/claudius/pistachio-media-player` on `codex/media-player-explorations`.

The production changes are confined to the media stack component, its styles, local icon assets, and card-presence helpers. Existing sidebar layout components, media contracts, and native playback handlers are unchanged. Cards use the current theme tokens for surfaces, text, borders, and accents.

The selected design includes compact artwork/title/subtitle rows, favicon badges, individual hover expansion, metadata-only close reveal, fixed-width speed controls with a slider popup, timestamps below the timeline, compact bottom progress, and animated entry/removal/repositioning. Video retains the live native frame. Original-tab navigation, PiP, previous/next track, seeking, mute, and read-aloud follow/cancel/error states remain available according to source capabilities. The expanded utility row preserves the extra video/read-aloud actions.

## Validation

- Desktop production build passed.
- Shell UI and desktop TypeScript checks passed.
- Shell UI lint and the updated Electron spec lint passed.
- Shell UI suite: 392 passed; 2 existing opt-in live tests skipped.
- Media reporting: 4 passed; media contract checks: 3 passed; read-aloud backend suite: 32 passed.
- All 3 real Electron journeys in `apps/desktop/e2e/tests/media-stack.spec.ts` passed: audio controls, native video/PiP/return-to-tab, and multiple video sources.
- Audio checks exercise the real media element for play/pause, seek, mute, speed/reset, and source-owned previous/next actions. The speed trigger and adjacent transport controls retain their geometry. Tests also check keyboard navigation, metadata-only dismissal, compact progress, dark theme, and reduced motion.
- Video checks cover background eligibility, live preview visibility and bounds, footer/address overlays, keyboard expansion, real PiP, returning to the original tab with scroll position preserved, video handoff, and intermediate animation positions during dismissal.
- Added stable test IDs for source favicon, metadata hover region, speed trigger, and speed popup.

Read-aloud provider calls were not exercised against a live account. Existing backend tests and additional component capability checks cover those paths.

## Screenshot review

Screenshots are generated under `apps/desktop/e2e/screenshots/media-stack/` (ignored by Git). Each was visually reviewed after the passing Electron run.

| Screenshot | Review |
| --- | --- |
| `expanded-stack.png` | Full-width timeline with muted times below; playback and return-to-tab controls fit. |
| `rate-slider.png` | Slider popup, plain speed value, and fixed-width trigger render correctly. |
| `metadata-dismiss.png` | Outline close icon appears beside shifted artwork and metadata. |
| `compact-stack.png` | Compact row has artwork, title/subtitle, play, and bottom progress. |
| `dark-expanded-stack.png` | Card, icons, text, and timeline follow dark theme tokens. |
| `dark-speed-slider.png` | Popup and slider remain legible in dark mode. |
| `video-mini-player.png` | Resting video reserves its frame and keeps compact metadata visible. |
| `native-video-frame.png` | Separate native-view capture confirms the actual moving video fixture renders. |
| `video-mini-player-compact-controls.png` | Hovering the video reveals its capability-dependent controls. |
| `video-mini-player-expanded-controls.png` | Metadata hover additionally reveals dismissal; PiP and return controls remain visible. |
| `two-videos-rest.png` | Rear card peeks from behind the front video with correct layering. |
| `two-videos-fanned.png` | Hovered rear card expands while the front video remains compact. |
| `survivor-after-dismiss.png` | Remaining video settles into place after removal. |

Electron shell screenshots omit native child views, so their video region appears gray. The separate native capture and assertions on actual preview visibility/bounds verify that view; this is a capture limitation.
