# Architecture

vivy is a Spicetify CustomApp: a page in the Spotify desktop client with a full-size canvas. It does not listen to audio. It reads Spotify's precomputed analysis of the track and draws from that timeline, so it can show what is coming as well as what is playing. Two presets ship: Ridgeline (`ridge`, Canvas 2D, the default) and Drift (`layers3d`, WebGL, marked experimental).

`DATA.md` covers the analysis fields, how far each can be trusted and the signals derived from them. This file covers how the code is put together. Source comments cite "DESIGN-RULES §n"; that file is not published.

## Data flow

```
Spicetify.Player ---------------+
Spicetify.getAudioData / fetch -+--> src/app.tsx --PresetFrame--> preset.draw(frame)
Spicetify.extractColorPreset ---+    (React shell,                 |
                                      rAF loop, input, UI)         +-- createConductor()  (flowfield-common.ts)
                                                                   +-- createNextSound()  (Drift only)
                                                                   +-- effects.ts, tune.ts
```

| file | what it does |
|---|---|
| `src/app.tsx` | React shell: canvas, frame loop, track and colour state, keys, fullscreen, mini window, knobs panel |
| `src/audio-data.ts` | loads the analysis; builds `TrackAudioData`; lookup helpers |
| `src/track-structure.ts` | finds the track's big moments and measures the run-in to each |
| `src/rhythm.ts` | decodes `rhythmstring` into broadband hits |
| `src/audio-sync.ts` | output-latency correction and the smoothed clock |
| `src/presets/types.ts` | `PresetFrame`, `Preset`, `PresetDefinition`, `currentEnergy` |
| `src/presets/index.ts` | `PRESETS`, the list the UI shows |
| `src/presets/flowfield-common.ts` | the Conductor, album-colour helpers, dev hooks |
| `src/presets/effects.ts` | key hue, glow, shimmer tint, energy trend |
| `src/presets/next-sound.ts` | the next sound's properties, for Drift |
| `src/presets/tune.ts` | live knobs |
| `src/presets/ridge.ts`, `layers3d.ts` | the two presets |
| `src/live-audio.ts` | system-audio analyser for the standalone window only |

## Loading the analysis

`loadTrackAudioData(uri)` in `audio-data.ts` tries `Spicetify.getAudioData` and then fetches the endpoint itself (DATA.md section 1 says why). It returns a `TrackAudioData`: the arrays, a per-track-normalised loudness curve, `hitScale`, `timbreSorted`, `sectionIntensity`, `moments` and `hits`. Lookup helpers there are binary searches: `sampleCurve`, `segmentAt`, `sectionIndexAt`, `timeSinceLastBeat`, `nearestBarStart`, `rankOf`.

`app.tsx` calls it from the `songchange` handler (`updateTrack`):

- one cached promise per URI, 10 s timeout, one retry after 1.2 s, at most four cached, and a prefetch of the next queued track so a natural advance has no gap;
- `audioDataRef` is set to `null` as soon as the track changes and filled when the analysis arrives, so presets see `audio: null` in between;
- only `spotify:track:` URIs are requested. Local files, episodes and ads never get an analysis;
- an empty or failed analysis falls back to `audio-features` (tempo and loudness only, `trackDataFromFeatures`), and if that fails the picture runs without data. Each case shows a notification;
- the cover colour comes from `Spicetify.extractColorPreset`; the displayed colour eases to it with a 0.6 s time constant, and stays on the last track's colour until the new one is known.

What each preset does without data: Ridgeline has no segments to build a shape from, so its rows are flat (on the beat grid when the features fallback gave one). Drift lights no marks, because `createNextSound` has no segments to announce, and its background layers follow the conductor's fallback level.

## Structure and rhythm

`track-structure.ts` exports `findMoments`. What runs is `findRises`: up to five places per track where the loudness takes its largest sustained step up, each with a `size`, a measured `leadSeconds`, and how far the music dips (`dip`) or climbs (`build`) on the way in. The older repetition-based chorus detector in the same file is switched off (`ENABLED = false`) and still runs under `npm run structure`. Details and measurements are in DATA.md section 3.1.

`rhythm.ts` exports `decodeHits` (inflate with `DecompressionStream`, parse eight bands of onset times, cluster onsets within 25 ms, keep clusters of at least three bands) and `hitIndexAt`. If inflating fails, `hits` is empty.

## The clock

`audio-sync.ts` has two parts.

- `AudioSync` opens an `AudioContext` with an inaudible 20 kHz tone at gain 0.0001 so the context is not suspended, and reads `outputLatency`. `getLatencySec()` only changes its value when the reading moves by more than 20 ms. `app.tsx` subtracts it from the playhead.
- `createSmoothClock()` fixes the player's whole-millisecond position. At 240 Hz the position steps 4, 4, 4, 5 ms, so anything moving by `position - lastPosition` jumps 20% on one frame in six. The clock advances by wall time and takes back 5% of its error each frame; an error above 50 ms (seek, pause, stall) is taken at once.

`progressSec` in a `PresetFrame` is the smoothed clock minus the latency.

## The Conductor

`createConductor()` in `flowfield-common.ts` returns a function that takes a `PresetFrame` and returns a `Conductor`: eased scalars from the audio, computed once per frame that renders. Each preset calls `createConductor()` inside its own `create()`, so state is per preset instance. The latest result is exported as `lastConducted`.

`dt` is `progressSec` minus the last call, clamped to 0..0.05. Eased values follow `v += (target - v) * min(1, rate * dt)`.

What the two presets read (full table in DATA.md section 3.3):

| signal | read by | for |
|---|---|---|
| `dt`, `scale` | both | time step; `min(width, height)` as the unit for sizes |
| `loudness` | both | the loudness without the per-segment sawtooth, from a centred window 1.5 beats wide. Every speed and the camera read this |
| `energy` | both | light only: dust, lit mountains and the halo (Ridgeline); the amplitude used when there are no segments (Drift) |
| `impact` | both | the release at a moment: the halo (Ridgeline), brightness and mark count (Drift) |
| `timeToImpact`, `anticipation`, `windup`, `runInDip`, `runInBuild` | Drift | the brace before a moment and the speed-up into it |
| `harmonicShift`, `brightness`, `attackSharpness` | Drift | wind turn rate and sheet light; field clock and sheet width; how far the background ducks under a flaring mark |

The conductor also computes cursor, beat-grid and accumulator signals that neither preset reads, and still reads `frame.mouse` to do so. Both presets ignore the mouse.

Between tracks the conductor holds `loudness` and `energy` near a rest level while the next analysis loads, then joins the new track's level over 1.5 s. This is what stops a track change from stepping every speed at once.

`flowfield-common.ts` also exports `albumHsl`, `hslToRgb`, `publishDiagnostics` / `lastDiagnostics`, and `getVariant` / `setVariant`. Nothing in the live presets reads the variant.

## The preset contract

`types.ts`:

- `PresetFrame`: `ctx` (2D context of the visible canvas), `width`, `height` (canvas pixels), `progressSec`, `isPlaying`, `audio` (`TrackAudioData | null`), `colorRgb` (eased album colour), `mouse`.
- `Preset`: `draw(frame)`. It is called every animation frame, playing or not. It owns whatever state it keeps.
- `PresetDefinition`: `id`, `name`, optional `experimental`, `create()`.
- `currentEnergy(frame)`: loudness-curve value, a sine when there is no analysis and playing, 0.5 when paused.

`index.ts` exports `PRESETS = [ridgePreset, layers3dPreset]`. The first is the default and what a new user sees. Saved choices and knob values are stored under the preset `id`, which is why Drift is still `layers3d`.

Rules every preset follows:

- A paused frame must not advance anything. Ridgeline draws once and then only when something it shows changes; Drift returns at once and the canvas keeps its last frame. `check-presets.js` asserts a paused frame issues byte-identical canvas calls.
- Shared logic goes in `flowfield-common.ts` or `effects.ts`, not into a preset.
- Time constants are per second or in beats of the track, never per frame.
- Knobs are declared once at module scope with `tune()`.

## app.tsx

Frame loop. `render` builds a `PresetFrame` and calls `preset.draw` in a try/catch (a failure is logged once and the next frame tries again), then schedules itself with `requestAnimationFrame` of the window the canvas is currently in. The 2D context is `{ alpha: false }`. `resize` follows the canvas box (window resize and a `ResizeObserver`); while paused it carries the old picture over, stretched, because setting a canvas size clears it.

Preset switching. The chosen id is kept in `localStorage` under `vivy:preset`. On change, an effect calls the new preset's `create()` and clears the 2D canvas. The preset buttons in the top bar come from `PRESETS`; experimental ones get an "exp" tag.

Input. The canvas tracks the mouse (position, speed, clicks, wheel, alt+wheel) and passes it in `frame.mouse`. Keys, all ignored with ctrl, alt or meta held and inside text inputs:

| key | |
|---|---|
| `F` | fullscreen on the container |
| `P` | mini window |
| `T` | knobs panel |
| `1`-`9` | dispatches a `visualizer-feature` event with the stored preset id and the number; Ridgeline listens |
| `B` | dev builds only: POSTs the numeric fields of `lastConducted`, track and position to the dev server's `/mark` |

The top bar and the track overlay hide after 2.5 s without mouse activity. The progress readout updates every 500 ms.

Mini window. `documentPictureInPicture.requestWindow` opens an always-on-top window. The canvas element itself is moved into it, so the preset draws at that window's size, and the frame loop switches to that window's `requestAnimationFrame` (a window nobody can see gets no frames). The client gives the window no frame, so it is moved with a `-webkit-app-region: drag` layer over the picture (all but a 10 px rim) and sized with `resizeTo`: wheel, `+` / `-`, or corner buttons that fade after 2.5 s of inactivity. `Esc` closes it. Other keys are forwarded to the main window. Size and position are kept under `vivy:pip-place`. On `pagehide` the canvas is moved back and the main loop resumes. A game in exclusive fullscreen owns the screen and cannot be drawn over.

Knobs panel (`TunePanel`). Lists the current preset's feature switches and sliders, grouped. Double-click a label to reset one knob; Reset resets all; Copy puts the moved ones on the clipboard as `preset KEY = value (was default)` lines, to be written back into the code as new defaults.

Dev builds (`stamp.js` without `--release`) also show the build time, report the grid and canvas size, and POST each analysis to the dev server's `/dump`. A release build sets `DEV = false` and none of that runs.

## tune.ts

```ts
const K = tune("ridge", { HORIZON: [0.3429, 0.05, 0.6, "horizon height", "view"], ... });
```

Each spec is `[default, min, max, label, group?]` (the group carries over to the following knobs). `tune()` returns an object whose properties are the live values. The panel writes into it and the preset reads `K.HORIZON` each frame. Persistence: values moved off their default are stored in `localStorage` under `vivy:tune:<preset>` as `[value, defaultAtTheTimeOfMoving]`. On load a stored value is used only if the code's default is still the one it was moved from, so changing a default in code wins and an old move does not come back when a default happens to return to its old value. `setKnob` clamps to the range. Every change bumps `tuneVersion()`, which a preset that caches work shaped by a knob (Ridgeline's rows and hills) compares to know when to redo it. `tuneFeatures()` shows a preset's number-key switches in the panel. `check-presets.js` runs each preset with every knob at its minimum and at its maximum.

Hints. The panel shows a knob's label and value; the tooltip on the label is its key and default.
## Ridgeline (`ridge.ts`)

The song as terrain coming towards the viewer, drawn as a ridgeline plot: rows from far to near, each filled below its line so it hides what is behind. Plain 2D canvas, redrawn whole every frame, so the glow pass may run on the whole picture.

Rows. A row is the song at one moment. Its height is the loudness then; its shape is the harmony then. `shape()` fills 96 points across: each of the 12 pitch classes is a Gaussian hill (`HILL` wide), laid across in circle-of-fifths order so a chord's notes stand next to each other and make one mountain. The hill is weighted by `pitches^1.5`, scaled by loudness, averaged over three samples across the row's span. A sharp segment (`loudness_max_time` short) roughens the ridge with noise (`JAG`); the line is then smoothed along its length (`SMOOTH`) and rounded off by `RIDGE_LIMIT * tanh(x / RIDGE_LIMIT)`. With no notes it is one broad hill. The row's section key hue and loudness are stored after its points. A row's shape is fixed while it is on screen (cached by index in a `Map`).

Where rows stand (`setGrid`, key 7, "rows on accents"). One row per segment, since a segment is where a sound begins. Its weight is the segment's `confidence`. Two segments closer than `ROW_GAP_MIN` beats become one row (the stronger). Bars add or mark a row at each bar start. Any stretch longer than `ROW_GAP_MAX` beats gets weightless filler rows so the ground has no hole. A heavier row is brighter and thicker. With the switch off, rows sit on the beats and their midpoints, all of one weight.

Depth is time, in beats of the track. `Z_NOW` is the depth of "now"; `FUTURE_BEATS` of future recede to `zFar`; `PAST_BEATS` of past sink towards the front edge (`sunkAt`, `playedAt`). Rows rise out of the fog at the horizon, flat at first (`farAt`). Perspective: base line `hy + ground / z`, width `half / z`, height `ridge / z`. Sizes are taken from the 16:9 picture that fits the screen, so an ultrawide does not stretch the terrain and a portrait screen does not shoot the peaks up.

The line at "now" is the waveform: the terrain's cross-section under the playhead. It chases the target shape at 14 per second, is drawn over everything, and never steps.

Presence. A new track or a seek (the playhead moves more than 0.5 s from the shown time) lets the old terrain sink flat on its own clock, then swaps in the new one and lets it rise. Paused, the terrain is put up directly at the paused moment and one frame is drawn; nothing is drawn again until the track, position, size, a knob or a feature switch changes.

The seven switches (keys 1-7, `FEATURES`):

| key | feature | what it does |
|---|---|---|
| 1 | horizon glow | a haze at the far edge, as bright as the next stretch of the track is loud, in the colour of the section coming. A low wide band (one radial gradient stretched across, `SKY_HEIGHT`/`SKY_WIDTH`/`SKY_BRIGHT`), drawn first so the far mountains are silhouettes |
| 2 | bars and section gates | the first beat of a bar is a brighter, heavier row. A section boundary is a row of its own in that section's colour, fainter if the boundary's confidence is low. It is a line and a colour only |
| 3 | colour by height | hue from the palette (see Colours) plus the section's key (`keyHueAt`), depth takes saturation out, row loudness sets lightness, one stroke graded paler towards the peaks |
| 4 | lit mountains | the body near "now" is faintly lit from its ridge down. The light is in the colour, never in the alpha, so the body still hides what is behind |
| 5 | camera | height and horizon follow the music, plus a slow side sway |
| 6 | dust | 70 specks drawn as short streaks along the line of flight, on the track's clock, kept above the tallest ridge, lit by `energy` |
| 7 | rows on accents | see above |

Camera. Two eased levels drive it, both read off the timeline: `lately` (a follower of `loudness`) and `ahead` (the loudness curve averaged over beats 4 to 16 ahead). It rides high over a loud passage and low over a quiet one, and crouches when `ahead` exceeds `lately`, so a build is seen from under the wall it is building. Lower also moves the horizon down, so the view looks up. Eased at 0.7 per second. The camera never reads the moment detector.

Echoes. When a sound has just been played (the count of segments before the playhead goes up by one to three), the mountains as they stand are copied as an echo: a skin of additive light between the live line and where the mountains were, with an edge where it stands off the line. It lives `ECHO_BEATS` beats, swells by an amount between `ECHO_SWELL_SOFT` and `ECHO_SWELL_HARD` by the sound's loudness over `hitScale`, and at most `ECHO_MAX` live at once. Nothing echoes across a track change or seek.

Finish. `createGlow` adds a tight core and a wide halo from the picture's bright parts; the halo's strength is `0.3 + energy * 0.6 + impact * 0.5`.

## Drift (`layers3d.ts`)

A volume of light ribbons that the camera drifts through, with one bright mark per sound. The particles live in three dimensions and their trails are ribbons in space, redrawn from the camera's place every frame.

Scene. A sphere of strokes (`CLOUD` radius). The camera sits inside it on an orbit of `ORBIT_RADIUS` (breathing by 18%), swaying up and down, looking at a point that wanders near the centre. Orbit speed is `ORBIT_REST + loudness * ORBIT_LOUD` radians per second, so near strokes sweep one way and far ones the other. Light fades to zero at the lens (`NEAR_DARK`, `NEAR_CLEAR`) and into fog (`FOG_START`, `FOG_END`).

Populations. `ground`: 520 wide dim ribbons, about 8 s life, the loudness of the last ten seconds. `sheet`: 1000 hairlines, about 3 s life, the loudness now. `marks`: a pool of 220, one per sound. Each stroke is born inside the sphere and fades to nothing before it is recycled.

Ribbons. Each particle remembers its last places in a ring on its layer's own clock, so a ribbon is as long in seconds on any screen. The strip drawn is resampled at exact fixed ages between the remembered places; drawing the remembered places themselves made every ribbon twitch whenever a new one was taken. The leading end is rounded, width narrows towards the tail and is capped as a fraction of the screen height, and a stroke seen end-on dims.

Motion. One wind in the world, as two rate-capped angles, wandering slowly (`harmonicShift` raises the cap). Every stroke is the wind plus bounded offsets: curl noise (divergence-free, so it neither clots nor leaves holes), re-read every few frames, and the wake of marks. A stroke's heading comes round to what is asked of it over an inertia time (`*_INERTIA`) and is never set directly. Speeds read `loudness`, never `energy`.

Marks. When `createNextSound` fires, marks are lit from the pool, `wanted` of them by the sound's amplitude, breadth and the release. Only a mark that has gone out is reused. A mark is placed across the wind by how ringing the sound was, at a depth between `MARK_NEAR` and `MARK_FAR`; the nearer ones start just off screen and fly in. Its charge rises through a smoothstep over the sound's `rise` and decays exponentially over `decay`. One channel each: ribbon length is pace (sharper sounds run faster), brightness is the sound's power, width is its breadth. A mark's head is a star quad drawn by a shader, white-hot and tight for a broadband crack, soft and wide for a voice. A sound that stands out gets a longer, further-thrown streak. The number of marks in play (`skySize`) follows a slow follower of `loudness` and changes one slot at a time, shrinking only past a mark that has gone out.

The wake. A lit mark combs, lights and hurries the strokes near it (`CUT_RADIUS`). It is the only coupling between layers, and it turns a stroke by a stored offset chased under a rate cap (`WAKE_RATE`), never by blending two directions.

Brace and release. `max(anticipation, windup * 0.8)` dims the picture and narrows how far the flow wanders before a moment; `windup` speeds the field up into it; `impact` (after the moment) adds brightness and more marks. These are scaled by the run-in's measured `dip` and `build`.

Colour. Album hue plus `keyHue`; three layer colours from it; `shimmerTint` shifts a layer's hue by the marks' light, capped at 0.4. Ground and sheet duck briefly when a mark flares.

Rendering. WebGL into an offscreen canvas (`alpha: false`, additive blending, so a ribbon over a ribbon is brighter), a ribbon shader and a head shader. The result is composited onto the frame's 2D context with `drawImage`, then `createGlow` adds the halo (strength `0.4 + tintPulse * 0.35 + release * 0.9`). WebGL is used because the 2D canvas cannot stroke ten thousand segments at 144 Hz.

WebGL handling.
- One renderer per page (`sharedRenderer`). `create()` reruns on every preset switch and a browser keeps only about sixteen contexts, so a context per switch would end with the oldest dropped and Drift black.
- No WebGL (headless check, or switched off in the client) or a shader that will not compile: the renderer is `null`, a notification says Drift needs WebGL, and the simulation still runs so its numbers are still checked.
- A lost context (GPU reset, driver update, sleep): each frame checks `isContextLost()`, drops the renderer and asks for a new one every 2 s until it comes. Everything made in the old context goes with it, so a whole new renderer is made.
- `publishDiagnostics("layers3d", { checksum, cameraX, cameraZ, heads })` each frame lets `check-presets.js` catch a NaN in geometry that no GPU would show.

## Build, check, release

| command | what it does |
|---|---|
| `npm run typecheck` | `stamp.js`, then `tsc --noEmit` (strict, no unused locals or parameters) |
| `npm run check` | `check-presets.js` (below) |
| `npm run build` | `stamp.js`, then `spicetify-creator`. Then `spicetify apply` puts it in the client |
| `npm run build-local` | minified build into `dist/` |
| `npm run release` | `stamp.js --release` (`DEV = false`), minified build, `release-notice.js` prepends the licence notice (the minifier drops it and simplex-noise is bundled), then `stamp.js` again to restore a dev stamp |

`stamp.js` writes `src/build-stamp.ts` (`BUILD` time and `DEV`). It is generated and ignored by git. A client reads `index.js` once at startup, so the stamp is how to tell a change that failed from one that never loaded.

`check-presets.js` compiles `src/presets/index.ts` and `audio-sync.ts` with `tsc` into `node_modules/.cache/preset-check` and drives every preset against a fake 2D context that throws on a non-finite number, a colour channel outside 0..255, a negative alpha, a non-positive line width or a negative arc radius. It runs each preset with a synthetic analysis and with `audio: null`: 400 frames at 60 fps with a moving mouse, a seek back 40 s, then paused frames that must produce byte-identical call logs. Then every knob at its minimum and at its maximum for 200 frames. Then the between-tracks level (never climbs while waiting, never steps by 0.02 in a frame) and the smooth clock (frame steps within 3%, within 2 ms of the player, a seek taken at once). It prints warnings for alpha above 1. It cannot see GPU output.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck` and `npm run check` on Node 20 for every pull request and every push to `main`. The release workflow runs on a tag like `v0.1.1`: the same checks, `npm run release`, zips `index.js`, `manifest.json` and `style.css` into a `vivy` folder as `vivy.zip` and attaches it to a GitHub release.

## Dev tools

`perf-serve.js` is a small dev server on `127.0.0.1:8790`: it serves files from the repository and accepts `POST /dump` (an analysis, to `analysis-dumps/`), `/mark` (to `marks.jsonl`), `/log` (to `probe-log.json`) and `/save/<name>` (a PNG, to `shots/`). It limits bodies to 20 MB and answers only this machine. Dev builds of the app post to it when it is running.

Preview harness (`npm run preview`, then `preview-harness.html`). Renders the presets in a plain browser tab from a synthetic track (`normaliseCurve` applied, no `hits` and no `moments`). Query parameters: `preset`, `warmup` (frames drawn synchronously before showing, since a headless tab cannot be trusted with `requestAnimationFrame`), `at` (the warm-up ends at this second), `fps`, `freeze=1`, `manual=1` (only `drawFramesSync` draws), `audio=shots/<name>.audio.json` (a real track, see `music-lab.js`). `warmup=900` lands in the quietest point of the synthetic track; `warmup=1260` is representative. Console helpers: `conducted()`, `diagnostics()`, `drawFramesSync(n)`, `saveShot(name)`. Space pauses, arrows switch preset. Headless screenshots: `msedge --headless=new --disable-gpu --window-size=1600,900 --virtual-time-budget=6000 --screenshot=<file> "http://localhost:8790/preview-harness.html?preset=ridge&warmup=1260"`.

Labs (`node <file>`, read `analysis-dumps/`; none run at playback):

- `music-lab.js "<dump>"` prints the music the way a listener hears it: bars, sections, texture, harmony, fills. `--picture` adds what a preset does beside it (`--preset=<id>`; needs `npm run check` run once for the compiled presets). `--audio-json` writes `shots/<dump>.audio.json` for the harness.
- `structure-lab.js ["<dump>" "<seconds>"]` runs the structure detector against real tracks and, with labels in `structure-labels.json`, scores it.
- `rhythm-lab.js` measures `rhythmstring` bands against the beat grid and segment starts.
- `compression-lab.js` buckets tracks by how hot the master is and counts the moments found in each.

Standalone window (`npm run live`, then `live.html`). `live-app.ts` runs the presets on whatever the computer is playing, in a plain browser window. `live-audio.ts` analyses system audio from `getDisplayMedia` (a screen share with "also share system audio") into the same `TrackAudioData` shape: RMS to loudness curve with a slow auto-gain, spectral-flux onsets as segments, FFT bins folded to pitch classes, the centroid as `timbre[1]`, strong onsets as beats. It has no bars, sections, moments or hits and cannot look ahead, so it trails the sound by about one analysis window (about 85 ms). `npm run live` serves the same dev server as above. Comments in `live-app.ts` still say "eight presets".
