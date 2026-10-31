<p align="center"><img src="branding/logo-wordmark.png" alt="vivy" width="240"></p>

# vivy

A music visualizer for Spotify, installed with Spicetify. It opens as its own page in the sidebar.

The picture is driven by Spotify's audio analysis of the track (notes, beats, bars, sections), not by the sound coming out of your speakers. Because the analysis covers the whole track, vivy can show what's coming up as well as what's playing now.

## Presets

**Ridgeline.** The track as a landscape that moves towards you. Each line is a moment of the song: height is loudness, shape is the notes in it. The bright line is the current moment.

<p align="center"><img src="branding/screens/ridgeline.gif" alt="Ridgeline" width="80%"></p>

**Drift** (experimental). Ribbons of light in a 3D cloud, one bright mark per sound.

<p align="center"><img src="branding/screens/drift.png" alt="Drift" width="80%"></p>

## Settings

Press `T` to open the settings. They are in four tabs. Hover over any setting to see what it does.

**Preset.** The sliders and effects of the preset on screen. The main ones are shown first, the rest are under *More settings*.

**Colour.** *Cover* takes the colours from the album art, *Custom* lets you pick two or three of your own. *Gradient follows* sets what moves a colour from the first to the last, for example the height of the mountains or how loud the music is. Each preset keeps its own colours.

**Picture.** Brightness, contrast, saturation and transparency, for every preset, and the frame rate. Transparency thins out the black behind the lines. With a Spicetify theme that has a background picture, the picture shows through. On Spotify's own look there is none, so the album cover shows instead, blurred. The frame rate is 30, 60, 120 or *Monitor* (every frame the screen shows, the default). A lower rate takes load off the graphics card on a fast monitor; the motion keeps its speed and only gets less smooth.

**Lyrics.** Draws vivy behind Spicy Lyrics, see below.

## Spicy Lyrics

If you use the [Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics) extension by Spikerko, vivy can draw behind its lyrics instead of its own background: on its lyrics page, in its fullscreen and in its cinema mode. It is off until you turn it on, in one of two ways:

- the button with vivy's mark in Spicy Lyrics' controls (next to its settings button);
- the *Lyrics* tab of vivy's settings, which also picks the preset and how dark the picture is, so the words stay readable.

It is not drawn in the lyrics card of the side panel. Spicy Lyrics can show a track's Canvas video in its fullscreen; while vivy is on, the video is hidden and the cover is shown. Without Spicy Lyrics installed, it does nothing. vivy uses none of Spicy Lyrics' code; it only draws into its page, so a change on their side can turn this off until vivy catches up.

## Install

vivy needs [Spicetify](https://spicetify.app). If you don't have it, install it first using their [getting started guide](https://spicetify.app/docs/getting-started), and check that Spotify starts with it.

Then:

1. Download `vivy.zip` from the [latest release](https://github.com/wairence/vivy/releases/latest).
2. Unzip it into Spicetify's `CustomApps` folder, so you have a `vivy` folder with everything from the zip in it (`index.js`, `behind-lyrics.js`, `manifest.json`, `style.css`). The folder is `%APPDATA%\spicetify\CustomApps\vivy` on Windows and `~/.config/spicetify/CustomApps/vivy` on macOS and Linux.
3. Run these two commands:

```bash
spicetify config custom_apps vivy
spicetify apply
```

To update, unzip the new release over the old folder and run `spicetify apply` again.

To remove it, run `spicetify config custom_apps vivy-`, then `spicetify apply`, and delete the folder.

## Keys

| key | |
|---|---|
| `F` | fullscreen (with a seek bar and previous / play / next) |
| `P` | mini window (stays on top of other windows) |
| `T` | sliders for the current preset |
| `1`–`7` | Ridgeline: turn individual effects on/off |

Mini window: drag it to move it, scroll or press `+` / `−` to resize it, `Esc` to close it.

## Notes

- Local files, podcasts and ads have no analysis. For those, the picture follows a simple pulse instead.
- Drift needs WebGL. Ridgeline doesn't.
- Tested with Spicetify 2.45.1 on Windows. The analysis comes from an undocumented Spotify endpoint, so a Spotify update can break it.
- vivy is vibe-coded: the code is written with an AI coding assistant, and what it should look like is decided by eye.

## Privacy

vivy only talks to Spotify:

- It fetches each track's analysis using your logged-in session.
- It takes the cover colour through Spicetify.
- It reads the cover image to find its colours.
- It stores the chosen preset, slider values, colours, picture settings, the Spicy Lyrics setting and mini window position in Spotify's local storage.

There is no analytics and no other server. It plays an inaudible tone to keep the audio device awake, which it needs to measure output latency. Nothing is recorded.

The Spicy Lyrics part is a second file, `behind-lyrics.js`, which Spotify loads at startup. While it is off it does nothing but add its button to Spicy Lyrics' controls.

## Development

```bash
npm install
npm run typecheck && npm run check   # type check, then run every preset on a fake canvas
npm run build && spicetify apply     # dev build into your CustomApps
npm run release                      # minified build in dist/
```

`docs/ARCHITECTURE.md` is the place to start, and `docs/DATA.md` covers the analysis data and what is derived from it. `npm run preview` renders a preset in the browser without Spotify.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/wairence/vivy/issues/new/choose). For a bug, say which preset and which track: some only show up on some songs.

## License

MIT, see [LICENSE](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not affiliated with Spotify. The name is a reference to *Vivy: Fluorite Eye's Song*.
