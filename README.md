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

Press `T` for the settings of the preset on screen. The main ones are shown first, the rest are under *More settings*. Hover over any of them to see what it does.

Colours: *Cover* takes them from the album art, *Custom* lets you pick two or three of your own. *Gradient follows* sets what moves a colour from the first to the last, for example the height of the mountains or how loud the music is. Each preset keeps its own colours.

## Install

vivy needs [Spicetify](https://spicetify.app). If you don't have it, install it first using their [getting started guide](https://spicetify.app/docs/getting-started), and check that Spotify starts with it.

Then:

1. Download `vivy.zip` from the [latest release](https://github.com/wairence/vivy/releases/latest).
2. Unzip it into Spicetify's `CustomApps` folder, so you have a `vivy` folder with `index.js`, `manifest.json` and `style.css` inside. The folder is `%APPDATA%\spicetify\CustomApps\vivy` on Windows and `~/.config/spicetify/CustomApps/vivy` on macOS and Linux.
3. Run these two commands:

```bash
spicetify config custom_apps vivy
spicetify apply
```

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
- It stores the chosen preset, slider values, colours and mini window position in Spotify's local storage.

There is no analytics and no other server. It plays an inaudible tone to keep the audio device awake, which it needs to measure output latency. Nothing is recorded.

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
