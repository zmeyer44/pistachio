# Sidebar media player directions

Design exploration on `codex/media-player-explorations`, based on `cc55a58`.

## Selected direction: refined soft stack

The current review is `soft-stack-preview.html`, built from the editable `soft-stack-refined.html` fragment. The original three-direction comparison remains available below.

The refinement uses three real sibling cards with explicit front-to-back paint order. At rest, audio uses a 58px row containing artwork, title, subtitle, and play/pause. Hovering the stack fans out the other players as compact rows; only the individually hovered or keyboard-focused card reveals its timeline, speed, auxiliary controls, and dismiss button. Moving between cards collapses the previous one. Gaps between cards belong to the stack's hit region, and a short exit delay avoids abrupt collapse. Clicking a title also exposes controls for touch users. Video keeps its frame visible at rest and while a different source is hovered.

Source counts and written source headers have been removed. Small badges on the artwork use the Spotify and Vimeo favicons, embedded from `https://open.spotify.com/favicon.ico` and `https://vimeo.com/favicon.ico`. The sample podcast and read-aloud sources use icon fallbacks, including a fallback when a favicon fails to load.

Expanded timelines span the available width, with muted elapsed and total times aligned below the bar. Compact audio and video cards have a 2px progress strip clipped to the rounded bottom edge. That strip hides on the individually expanded card, while compact neighboring cards retain theirs. Both indicators share the same position updates for seeking and rewind/forward; browser checks verified synchronized fills and the compact/expanded visibility switch.

Each source has its own playback speed popover, inspired by the supplied September 19 screen recording. It has a native slider from 0.25× to 2× in 0.25 increments, marked stops, a current value, and reset to 1×. The popover sits above all media cards, chooses above/below placement to fit the window, retains its state during dragging and saved-state echoes, closes on outside interaction or Escape, and restores trigger focus on Escape.

Speed triggers reserve a fixed 64px slot, with rewind/forward in a separate centered grid column. The trigger and popover display plain, unanimated speed numbers. The fixed width keeps adjacent controls stationary across playback speeds.

Browser validation covered the compact audio/video states, hidden resting controls, actual mouse entry/exit and movement between cards, exactly one expanded card at a time, compact neighboring cards, persistent video frame, favicon rendering, keyboard speed adjustment and Escape, and retention of only the owning card while its speed popover is open. Earlier slider checks covered dragging, reset, range boundaries, and collision placement. No browser JavaScript errors were observed. The artifact remains an interactive design preview with sample artwork and simulated playback. The production implementation is now complete in this worktree; see [implementation and validation](IMPLEMENTATION.md).

## Initial exploration

Open `preview.html` for the standalone review. `media-player-directions.html` is the editable inline artifact source. The production implementation now follows the selected soft-stack direction.

- **A — Soft stack:** opaque pale cards, shallow stacked edges, controls revealed by hover or keyboard focus, click to expand the other sources.
- **B — Album deck:** larger artwork, a moss-colored surface, persistent transport controls, other sources expand above the active player.
- **C — Media shelf:** integrated sidebar divider, compact artwork and controls, no floating card shadow; other sources unfold above the shelf.

All use the same sample content. Audio/video switching, play/pause, mute, speed, seeking, track switching, stack expansion, and direction selection are interactive local simulations. Video uses a CSS sample still. Picture in picture indicates a selected preview state; it does not open a real media window. Playback does not emit audio. The optional host design controls expose appearance and persistent soft-stack controls.

Reference direction: [Luma Discover](https://luma.com/discover) for restrained surfaces, imagery, and hierarchy; [Transitions.dev](https://transitions.dev/skill.html) for purposeful reveals and control transitions. No external skill installed.

The study retains the existing product's Geist typography, bottom-anchored sidebar position, three-source stack, and video-first concept. Final implementation should preserve capability-gated controls, native video bounds reporting, read-aloud behavior, and background-media ordering from `MediaStack.tsx`.

Validation: browser review of audio and video layouts, expanded sources, playback toggling, source switching, selection persistence, and narrow-screen reflow. Fixed an artwork sizing conflict in the expanded album-deck source list. No browser JavaScript errors observed. Reduced-motion handling is included. These checks describe the original design study; production integration and regression checks are documented in [IMPLEMENTATION.md](IMPLEMENTATION.md).

The refined study uses embedded Phosphor Icons 2.1.1 fill variants for player controls and sidebar icons, with the regular outline variant for the dismiss ×. Original Spotify and Vimeo favicons are retained. Icon licensing is in `phosphor-icons-LICENSE.txt`.

Card spacing is tightened to 10px content insets, 8px artwork gaps, and 6px between fanned cards. Compact cards are 54px tall; expanded audio cards are 116px (136px on touch). The speed popup also uses reduced padding; control sizes and the fixed speed-trigger width are preserved.

Dismiss reveals only when hovering the artwork/title/subtitle component (or keyboard-focusing its controls): the artwork and metadata translate right over 220ms while the outline × fades/slides in. The play button stays anchored, and the reveal reverses on disengagement. The revealed close button shares that hover region so it remains reachable; playback controls and the rest of the card do not trigger dismissal. Hidden dismiss controls remain inaccessible. Removing the separate header saves 24px in expanded cards, including video cards. Reduced-motion preferences disable the transition.

Cards enter with the supplied toast treatment (350ms, 16px rise, 2px blur, 0.97 scale) and exit over 250ms. Dismissal retains the card until its exit finishes, then removes only that element; surviving cards animate their measured position changes over 350ms. Restoring sources also animates new cards and existing positions. Motion composes with the stack scaling, supports interrupted/repeated actions, preserves keyboard focus, and finishes immediately under reduced-motion preferences. Lifecycle checks cover timing, delayed removal, duplicate dismissal, preserved survivor identity, reflow, focus, empty state, cancellation, and reduced motion.
