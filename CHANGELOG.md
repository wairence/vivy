# Changelog

## 0.3.0 — unreleased

- Spicy Lyrics: vivy can draw behind its lyrics, on its page, in its fullscreen and in its cinema mode. A button with vivy's mark in Spicy Lyrics' controls turns it on; the Lyrics tab of the settings picks the preset and how dark it is. It is a second file in the app, `behind-lyrics.js`, which Spotify loads at startup. Update by unzipping over the old folder and running `spicetify apply`.
- Settings are in four tabs: Preset, Colour, Picture, Lyrics. The frame rate moved to Picture.
- Picture: brightness, contrast, saturation and transparency for every preset (#13). Transparency lets a theme's background picture show through; on Spotify's own look it shows the cover, blurred.
- Fullscreen: a like button next to previous / play-pause / next (#13).
- Drift: shows a picture when first opened while paused (#3); says on screen that it needs WebGL when it cannot start (#4); ribbons stay visible in a small mini window (#6).
- Drift: no jolts from the sound. Marks are no longer thrown on their hit, the field no longer speeds up with the loudness of the moment or winds up before a drop, and strokes no longer hurry in a mark's wake, so the FLING, FLING_RANK and WAKE_HURRY settings are gone. Speed follows the ten seconds around it, so a chorus moves a little faster than a verse. Marks that fly in start inside the edge, at their own place, and no longer die before they get on screen.
- Colours: every shift of hue (the section's key, the line and marks turning, Drift's shimmer) now stays within 30 degrees of the cover's own colours, turning towards its other colours; a red cover no longer gives green lines or a teal one purple marks. A black-and-white cover stays grey instead of turning red or orange. A cover whose colours Spotify does not give is read from its own pixels (a teal cover was drawn blue, then purple).
- Ridgeline: the horizon glow eases into a new section's key instead of jumping.
- The first track after Spotify starts is picked up even without a track change.
- The canvas renders at most 1080p worth of pixels and is stretched above that, so Ridgeline holds 240 fps on a large screen (#5).
- The sidebar icon fills its box on themes where it stuck out.
- Frame rate setting: 30, 60, 120 or the monitor's own (default).
- Memory: Drift's WebGL context and both presets' glow buffers are released when you switch presets or leave the page; before, Drift's stayed for as long as Spotify ran.
- Code: comments cut down to what the code does not say, the settings page split into components, unused signals and the switched-off chorus detector removed.

## 0.2.0 — 2026-10-19

- Colours: from the cover or your own (two or three, with a colour picker), and a choice of what the gradient follows. Each preset has its own.
- Settings panel: a short explanation on hover for every setting; the main settings first, the rest under More settings.
- New settings: halo strength (both presets); line thickness, dust brightness and camera sway (Ridgeline).
- Ridgeline: the horizon glow is a low wide band instead of a round spot. The reflection effect is gone.
- Drift: draws a frame while paused, so a change made while paused shows at once and switching to Drift is no longer black.
- Fullscreen: seek on the progress bar, and previous / play-pause / next under it.
- Mini window: the buttons are proper icons.

## 0.1.0 — 2026-10-19

First public release: Ridgeline, Drift (experimental), mini window, live sliders.
