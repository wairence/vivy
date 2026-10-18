# Architecture

How this codebase is put together, what every signal means, and which rules are
load-bearing. Written to be read start-to-finish once, then used as reference.

Companion documents:
- [`SIGNALS.md`](SIGNALS.md) — the audio/gesture signal reference table
- [`DESIGN-RULES.md`](DESIGN-RULES.md) — rules learned by breaking them; read before touching motion code

---

## 1. What this is

An audio-reactive visualizer that runs as a **Spicetify CustomApp** — a separate
tab inside the Spotify desktop client with a fullscreen `<canvas>`. Not a theme,
not an injected extension.

Two things make it different from other music visualizers, and both matter for
where the product goes next:

1. **It does not listen to audio.** It reads Spotify's *precomputed per-track
   analysis* (beats, segments, per-segment loudness/timbre/chroma) and drives
   everything off a timeline. No FFT, no microphone, no latency guessing beyond a
   single output-latency correction. This is why the motion can anticipate rather
   than react — the whole track's structure is known in advance.
2. **The cursor is an instrument, not a pointer.** Where it is read at all, it is
   a control surface layered on the music: it never spawns, never selects, never
   points at anything. It bends a field that is already moving. See
   [`DESIGN-RULES.md`](DESIGN-RULES.md) §1.

   **It was removed from Layers II on 2026-08-30 and rebuilt on 2026-09-02/03.**
   The old gesture layer went because the sweep in DESIGN-RULES §12 measured every
   one of its signals at under 2% of what reaches the screen. What replaced it is
   conducting (DESIGN-RULES §1d): the hand is a MAGNITUDE on the music's clock
   (`baton` over a bar, `hand` over a beat), plus a place it has been (`trailAt`)
   and a click that is a glow and a ring (`rippleAt`). It lights, stirs and hurries
   what is already flying; it never births anything and never sets a direction.
   Measured after the rebuild: a big sweep is 18.3% of the light on screen against
   4.2% before, with zero turns over 0.3 rad.

Four presets ship as of 2026-09-20: **`layers2`** (the picture), **`smoke`** and
**`plate`** (both ported from proven work — see §7.4 and §7.5) and **`signal-scope`**
(the instrument). Nine more are in `src/presets/archive/`, still compiling, one import
from coming back — see that folder's README for what each was and what is worth taking
from it.

---

## 2. Runtime context

| | |
|---|---|
| Host | Spotify desktop client (Electron/CEF), `Spicetify.*` globals |
| Build | `spicetify-creator` → `manifest.json` + `index.js` + `style.css` |
| Deploy | `spicetify apply` (re-injects into the client) |
| Install target | `%APPDATA%\spicetify\CustomApps\<name>\` |
| Rendering | Canvas 2D only (the WebGL path was removed — nothing used it) |

Two Spicetify APIs carry all the data:

- `Spicetify.Player` — current track, play state, `getProgress()`, `songchange`
- `Spicetify.getAudioData(uri)` — the per-track analysis (beats/segments/tempo).
  Undocumented internal endpoint, but stable and used by other visualizers.
- `Spicetify.extractColorPreset(imageUrl)` — album art → accent colour

**The analysis was under-read for the whole life of the project.** `getAudioData`
returns `bars`, `tatums` and `sections` alongside `beats` and `segments`, but
`SpotifyAudioAnalysis` only ever declared the latter two, so the metrical grid and
the track's own structure arrived with every track and were thrown away. Declaring
them is what made §1's claim about anticipating rather than reacting true — see
[`SIGNALS.md`](SIGNALS.md).

**Commercial note:** items 2 and 3 are the platform dependency. Porting off
Spicetify means replacing `getAudioData` with either a licensed analysis API or
an on-device analysis pass. The rest of the codebase does not care where the
analysis comes from — it only consumes `TrackAudioData` (§4.1).

---

## 3. Layer map

```
Spicetify.Player ──┐
Spicetify.getAudioData ──┤
Spicetify.extractColorPreset ──┘
              │
              ▼
     ┌──────────────────┐
     │   app.tsx        │  React shell. Owns the canvas, the rAF loop,
     │                  │  all raw input, track/colour state.
     │                  │  Builds one PresetFrame per frame.
     └────────┬─────────┘
              │  PresetFrame { ctx, width, height, progressSec,
              │                isPlaying, audio, colorRgb, mouse }
              ▼
     ┌──────────────────┐
     │  preset.draw()   │  One of 8. Owns its own particles and look.
     └────────┬─────────┘
              │ calls, in this order, every frame:
              ▼
     ┌──────────────────────────────────────────────┐
     │  conduct(frame)  →  Conductor                │  flowfield-common.ts
     │    all eased audio + gesture scalars         │
     ├──────────────────────────────────────────────┤
     │  gesture.begin(frame, c, fieldTime)          │  flowfield-common.ts
     │    ripple bookkeeping, shimmer phase         │
     ├──────────────────────────────────────────────┤
     │  bloom.begin(w, h)  →  offscreen ctx         │  flowfield-common.ts
     ├──────────────────────────────────────────────┤
     │  per-particle: field math, gesture bends,    │  the preset's own code —
     │  stroke colour/width, integrate, respawn     │  this is the ONLY part
     │                                              │  that differs between presets
     ├──────────────────────────────────────────────┤
     │  bloom.flush(frame, c)                       │  flowfield-common.ts
     └──────────────────────────────────────────────┘
```

The important structural fact: **a preset is only its field math and its look.**
Every preset drives the same conductor, the same gesture layer, the same bloom
compositing. If you find yourself writing per-preset code for anything else,
that logic belongs in `flowfield-common.ts` — see §7.

---

## 4. Module reference

### 4.1 `src/audio-data.ts` — the analysis adapter

Turns Spotify's raw analysis into the only shape the rest of the app knows:

```ts
type TrackAudioData = {
  beats:    { start, duration, confidence }[]
  segments: { start, duration, loudness_start, loudness_max,
              loudness_max_time, loudness_end, pitches[12], timbre[12] }[]
  loudnessCurve: { t, y }[]   // dB → linear amplitude, sampled from segments
  tempo: number
}
```

Plus three binary-search lookups used everywhere: `sampleCurve`,
`timeSinceLastBeat`, `segmentAt`. All O(log n) per frame.

**This is the platform seam.** Swap the body of `loadTrackAudioData` and the
whole visualizer runs on a different analysis source.

**Loudness is normalised per track.** `buildLoudnessCurve` maps each track onto its
own 5th and 95th percentiles, so `energy` spans roughly 0.06–0.62 whatever the
mastering did. Without it a track mastered at −13 dB sat at 0.22 for its whole length
and rendered as a permanent quiet interlude: dim, slow, nothing happening. Percentiles
rather than min and max, because one silent outro would otherwise define the scale.

**When a track has no analysis.** `getAudioData` calls an internal client endpoint,
`spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/{id}`, and some tracks
genuinely 404 there — it resolves with `{ code, error, message }` rather than
rejecting, so the failure used to surface far downstream as "segments is not
iterable" and read like a parsing bug here. `loadTrackAudioData` now recognises that
shape and throws the real code.

Its **sibling on the same internal path**, `audio-features/{id}`, still answers for
those tracks: one summary row with Spotify's own measured tempo, loudness, key and
energy. (The public Web API equivalent, `api.spotify.com/v1/audio-features`, is
closed to applications and returns a flat 429 on every attempt including after a 9 s
backoff — that is a refusal, not a rate limit.) `trackDataFromFeatures` turns that
into a `TrackAudioData` with a beat grid at the real tempo and a flat loudness curve
at the real loudness.

The curve is left **flat on purpose**. There are no segments, so no attack
character, no harmonic movement and no verse-versus-chorus dynamics. Inventing an
envelope to fill that in would be exactly the made-up heuristic DESIGN-RULES §8
exists to prevent; a picture that pulses honestly at the right tempo beats one
pretending to hear a structure it has no data for.

### 4.1b `src/track-structure.ts` — where the big moments are

Self-similarity analysis over per-bar chroma and timbre: build feature vectors, find
boundaries with a Foote checkerboard novelty kernel, group the blocks those
boundaries open, and take the group that repeats while being loud and bright. Its
occurrences are the moments, each with a **measured** description of what the music
does on the way in — how long the run-in lasts, how far it dips, how much it builds.

Runs once when a track loads; a few hundred bars is a few tens of thousands of
comparisons. Returns nothing when nothing repeats convincingly, which is the correct
answer for a through-composed piece and is much better than an invented moment.

See [`SIGNALS.md`](SIGNALS.md) for why loudness could not do this job.

**It is validated against real tracks, and it has to be.** An earlier version scored
3/3 with no false positives on synthetic songs and then found the entire song to be
one chorus on actual music: the test data had been generated to match the algorithm's
own assumptions, which makes it a mirror rather than a test. Real music sits in one
key, so per-bar chroma vectors are similar *everywhere* and every block grouped
together — a failure the synthetic chords, made artificially distinct, could not
express.

`npm run structure` scores the detector against `structure-labels.json`, which holds
where a listener actually hears the big moments in real tracks. The analyses come
from `analysis-dumps/`, written by the app whenever a track loads and the dev server
is running (one file per track — a single shared file was silently overwritten the
moment Spotify advanced to the next song, which once pointed a whole tuning session
at the wrong track's data). Current across eight labelled tracks: **6 of 20 moments found, 0 spurious.** It
fires on two tracks and is right every time it does; on the other six it stays
silent.

That trade is deliberate. Firing on everything it could find scored 12 of 20 with
10 spurious — about half of all firings wrong — and a release nobody can account
for reads as the visual malfunctioning, while a chorus passing unmarked is simply
invisible. Two gates buy the precision: the winning reading of a track's structure
must have at least three occurrences, and must beat the next-best reading by 2.5×.
Every track the detector got completely right cleared both; every track it got
wrong failed at least one.

A third guard came from the listener rather than the data: the false firings looked
*more* intense than the real ones and always out of place. That is what a gesture
with no musical support looks like — at a real chorus the music grows alongside it
and the two merge, while at an invented one the visual is the only thing happening.
So loudness, which could never *find* a chorus, is used to *veto* one: if the ten
seconds after a moment are no bigger than the ten before, nothing arrived there.

**It is switched off** (`ENABLED = false` in `track-structure.ts`). A chorus was
reported as landing well on a track where the detector stays silent and badly on both
tracks where it fires — the audio-driven response gives a chorus its arrival without
being told where one is, and the anticipation was subtracting from that rather than
adding to it.

And the scoreboard that argued otherwise cannot be trusted as it stands: one track's
labels turned out to be the times the *visualiser had fired*, not the times a chorus
happens, so its perfect 3/3 was the detector graded against its own output. Labels
must be collected by ear with the visual ignored. Everything still runs under
`npm run structure`; nothing acts on it until that is redone.

Two findings from that scoreboard are worth keeping:

- **A fixed clock grid is worse than a bar grid**, tried and measured. Structure lives
  in phrases, so a kernel of four bars asks the same musical question of a slow track
  and a fast one, while a kernel of twelve seconds asks a different question of each.
- **But bars that are too long have to be subdivided.** Two labelled tracks came back
  with ~3 s bars, leaving 49 and 57 frames for a whole song, and both failed outright
  until long bars were halved.

### 4.1c `src/rhythm.ts` — the audio's own onsets

`track.rhythmstring` is the one part of the analysis that describes onsets measured
from the audio rather than a grid fitted over it. zlib, URL-safe base64, and it
decodes to plain text: `sampleRate hopSize bandCount`, then per band a count and
that many frame-index deltas. Eight bands at 11025 Hz with a 32-sample hop — 2.9ms
resolution. Inflated in the browser with `DecompressionStream`, so no dependency;
if that is unavailable the caller falls back and says so out loud.

**It is not a drum track.** Every band's own event rate is pinned near 3 per second
whatever the tempo or the music does — measured across 81 dumps, and again in
`music-lab.js`, where one band ran at 8.5/s from the first bar of a song to the
last. What is usable is where the bands AGREE: a real drum is broadband and lights
several at once. A cluster that at least three bands contribute to within 25ms is a
hit.

Against the beat grid over 81 tracks: 44% precision and 63% beat recall, where the
old segment rule managed 28% and 51%. Firing `strike` off those onsets *directly*
was tried and measurably reversed — better detector, worse picture — because
everything else in the visual runs on the segment clock and two clocks smear each
other. So the onsets **gate** the segment clock: a segment is a hit when the bands
agree within 60ms of it.

The band count survives as a quality (how broadband, 3..8) and never as a gate. It
cannot, however, say anything about REGISTER: 48% of hits touch the lowest band and
the highest at once, which is what a broadband sound is.

### 4.2 `src/audio-sync.ts` — latency correction

`Player.getProgress()` reports when audio was *queued*, not when it is *heard*.
`AudioContext.outputLatency` is the gap. An inaudible 20 kHz tone keeps the
context alive (a suspended context reports stale latency). 32 lines, adapted
from Konsl's visualizer (MIT).

### 4.3 `src/app.tsx` — shell and input

Owns:
- canvas sizing (devicePixelRatio-aware), fullscreen, idle-hide chrome
- track metadata + accent colour (eased toward the target at 0.05/frame)
- **all raw input**, accumulated into `MouseState`

`MouseState` is deliberately *raw and cumulative*, never eased here — easing is
the conductor's job, in one place:

| field | meaning |
|---|---|
| `x`, `y` | canvas-space cursor position |
| `speed` | lightly smoothed px/frame (0.8/0.2 EMA) |
| `clicks`, `rightClicks` | **cumulative counters**, not flags — a click between frames can never be missed |
| `down`, `rightDown` | button physically held (released on mouseup / mouseleave / window blur) |
| `scroll` | persistent 0..1 knob (wheel) |
| `particleScale` | persistent 0..1 knob (alt+wheel) |

Also hosts one dev affordance: **ctrl+click** dispatches
`flowfield-dev-toggle`, carrying the active preset's id (§6).

### 4.4 `src/presets/types.ts` — the contract

`PresetFrame`, `Preset { draw(frame) }`, `PresetDefinition { id, name, create }`.
A preset is a factory: `create()` returns a closure holding its own particles.
`app.tsx` calls `create()` fresh on every preset switch.

### 4.5 `src/presets/effects.ts` — stateless/small-state primitives

No knowledge of the conductor or of any preset. Reusable pieces:

| export | what it does |
|---|---|
| `fadeTrail` | translucent full-frame fill — the trail accumulation |
| `shimmerPhase` / `shimmerTint` | cheap channel-rotation iridescence (capped at 0.4 blend — see §8) |
| `createChromaTracker` | eased 12-band pitch-class energy |
| `createEnergyTrend` | fast (~2s) vs slow (~20s) energy averages → `level`, `trend` |
| `createRippleTracker` | the click/hold ripple state machine (§5.2) |
| `rippleInfluence` / `rippleGlowAt` | ripple → direction+weight / → brightness |
| `resizeToCount` | in-place particle array grow/shrink |
| `createDensityGrid` | O(n) coarse-grid local density (clustered = brighter) |
| `timbreBrightness` | `timbre[1]` → −1..1 spectral brightness |

### 4.6 `src/presets/flowfield-common.ts` — the shared brain

Four factories plus colour helpers. **All three live presets use the conductor and the
bloom.** `layers2` calls `gesture.begin()` only for the shimmer phase — its ripple state
machine runs and nothing reads it; the rebuilt `flowfield` does not use the gesture layer
at all. The archived eight still do.

- **`createConductor()`** — the single source of truth for every eased scalar.
  Full signal reference in [`SIGNALS.md`](SIGNALS.md).
- **`createGestureLayer()`** — ripple bookkeeping (`begin`), ripple direction
  bend (`bendTowardRipple`), cursor/ripple brightness (`glowAt`), hit shimmer
  (`tint`).
- **`createBloomLayer()`** — `begin()` hands out a cleared offscreen context;
  `flush()` composites it onto the trail canvas **sharp first**, then adds a
  blurred `lighter` pass. Blurring only this frame's fresh strokes is
  load-bearing: blurring the accumulated trail canvas re-blurs its own history
  and whites out the screen within seconds.
- **`particleTargetCount()`** — the alt+scroll count knob, clamped per preset.
- **`lerpAngle()`** — shortest-path angle blend. *Every* gesture influence goes
  through this. See [`DESIGN-RULES.md`](DESIGN-RULES.md) §1.
- **`albumHsl()` / `hslToRgb()`** — album colour → HSL with saturation/lightness
  clamped into a usable band, so a near-grey cover cannot collapse the
  hue-shifting presets into mud.

### 4.7 `src/presets/telemetry.ts` — diagnostic recorder

Records per-frame mouse + audio + field state to a downloadable JSON file for
offline analysis. Currently wired into **Aurora only**, toggled by ctrl+click.
`angleCoherence(angles)` returns circular variance (0 = all aligned, 1 =
scattered) — the metric for "are particles agreeing or confused". §6.

---

## 5. The control surface

### 5.1 Input map

| input | effect |
|---|---|
| cursor X | bloom/glow send amount |
| cursor Y | attract (top) ↔ repel (bottom) — `yAttraction` |
| cursor motion | `gustAngle` + `gustStrength` + `gustCoherence` |
| flick **down** | `chaos` — field goes busy, high-frequency, hazy |
| flick **up** | `order` — field goes laminar, clean, sharp |
| left click / hold | outward ripple (push) |
| right click / hold | inward ripple (pull) |
| wheel | global speed fader |
| alt + wheel | particle count |
| ctrl + click | telemetry record toggle (dev) |

Repeated flicking accumulates a slow `chaosTotal`/`orderTotal` baseline that
decays over ~45 s — conducting for a while actually leaves the piece changed for
a while. Structural formulas should read `*Total`; only read the raw pulse when
you specifically want "during the flick itself".

### 5.2 The ripple, precisely

Two independent ripples (`pos` = left/push, `neg` = right/pull), each:

```
strength : snaps to 1 on click, pinned at 1 while held,
           decays linearly at 1.1/s once released  (~0.9 s to zero)
reach    : chases strength at 2.6/s                (~0.4 s lag)
liveRadius = maxRadius * reach
```

`reach` lagging `strength` is the entire mechanic. Because it trails on the way
up *and* on the way down, the influence visibly spreads outward and then visibly
contracts as it fades — from one chase, not two clocks. An earlier version
computed spread and shrink separately and combined them with `Math.min`; they
fought, and a plain click never opened far enough to be seen. Do not reintroduce
a second timer here.

---

## 6. Telemetry workflow

Because the visualizer only runs inside Spotify, there is no way to watch it
while developing. When a motion problem resists reasoning, record real data:

1. **ctrl+click** the canvas → "Telemetry recording"
2. play and move the cursor the way that feels wrong
3. **ctrl+click** again → JSON lands in Downloads
4. analyse offline (replay the formula against the recording before shipping a fix)

This has already found two real bugs that reasoning alone had missed — a
physically-impossible spin-rate signal, and `gustStrength` saturating during any
vigorous movement. Both fixes were validated against the recording *before*
shipping.

Two gotchas, both already fixed, both easy to reintroduce:
- The recorder and its listener live at **module scope**, not inside `create()`.
  `create()` re-runs on every preset switch and would leak a duplicate listener
  each time; only the active preset's `draw()` runs, so most listeners would
  export an empty array.
- The toggle is a **mouse** event, not a keyboard shortcut. `Alt+<key>` gets
  eaten by Electron's native menu accelerators before reaching page JS.
- More than one preset now listens (Aurora records, Layers switches to its
  diagnostic palette), and every listener lives for the whole session, so the
  event carries the active preset's id and each listener ignores what is not
  addressed to it. Without that, one ctrl+click fired both — two notifications
  and a telemetry recorder quietly running from a preset nobody was looking at.
  The id is read from `localStorage`, not from React state: the handler is
  registered once on mount and would otherwise close over a stale preset.

---

## 7. The presets

Four are registered; nine are archived. All of them share the conductor and the bloom.
What differs is the field math and the drawing.

**One of the four is a particle preset and two are not**, and that is deliberate: `smoke`
draws a pixel buffer and `plate` draws a field of grains, so a fault in one of them
cannot be a fault in all of them at once.

| id | name | field | drawn as |
|---|---|---|---|
| `layers2` | Layers II | **three populations** on one wind, each driven by its own layer of the music, coupled only through the wake a mark leaves. See §7.2 | a wide dim ground, a sheet of hairlines, and one mark per sound |
| `smoke` | Smoke | **a fluid.** Stable Fluids (Stam 1999) on a 192-wide grid: the velocity field advects itself, the dye rides it. Every sound is a puff and an impulse; the wind's speed is the loudness. See §7.4 | one `putImageData` a frame, upscaled and bloomed |
| `plate` | Plate | **a scalar field, and sand on it.** Chladni figures: twelve modes, and grains walking down the gradient of the field's own magnitude to where the plate is still. The harmony chooses the figure. See §7.5 | one small `fillRect` per grain, up to 12 000 |
| `signal-scope` | Scope | **not a field at all** — an instrument. Draws the conductor's signals against the track's own beats, bars, sections and segments, plus the segments that have *not happened yet* with the size, sharpness and bar alignment `lookAhead` is reading off them | 16 lanes with 6 s of history, and a −6 s..+2.5 s strip |

`signal-scope` exists because every other preset answers "did the system react?" only
through weather, and weather cannot be read as a number: when a chorus lands flat there
is no way to tell from the canvas whether the signal missed it or the movement swallowed
it. It is also the only place the *future* is visible. Switch to it, play the track that
misbehaved, and the answer is on screen.

**Why the other eight left.** None had been looked at in weeks; all carried the old
gesture layer and signals the sweep of DESIGN-RULES §12 measured at under 2% of what
reaches the screen; and eight copies of one mechanism is how the shimmer bug survived in
seven presets at once (§7 of DESIGN-RULES). Three presets is three that get judged.

---

### 7.1 Layers, and how its groups are coupled

The other seven presets blend every audio signal into one field that every particle
follows. `flowfield-layers` instead runs three groups, each reading only the signals
that belong to its layer of the music:

| group | reads | ignores | motion | mark |
|---|---|---|---|---|
| bass / pads | `level`, `trend`, `energy` | anything beat-crisp | noise freq 0.6, drift ×0.35, ~8 s life | wide, dim, near-transparent — a wash |
| melody | `harmonicShift`, chroma, `brightness` | — | noise freq 1.2, drift ×1.0, ~3 s life | hairlines with trails |
| percussion | `pop`, `attackSharpness`, `beatHit` | `level` | noise freq 2.0, drift ×2.2, **melody's speed ×1.35**, beat as a modulation | short dashes, dormant between hits |

**One wind.** All three travel along a single shared direction, `groundAngle`, and a
group's identity is *how widely it wanders around it* — never a heading of its own.
Both other groups are bounded offsets from the ground: melody leans up to
`MELODY_TILT_MAX` (0.5 rad) with the harmony, percussion deviates up to
`PERC_SPREAD_MAX` (0.9 rad). Neither can reach π, which is what makes the
arrangement safe as well as coherent — see DESIGN-RULES §1c.

The first version got this wrong: percussion was fully isotropic and melody's frame
was `lerpAngle(groundAngle, melodyTilt, 0.4)` where `melodyTilt` was an absolute
angle from the chroma. Measured, the three layers agreed only 0.79, and the melody
frame jumped ~2.5 rad in a single frame 5.5 times a second. Anchoring everything to
one wind took layer agreement to 1.00 and the peak single-frame turn from 154 rad/s
to under 2.

The groups also influence each other — but **never continuously and never
symmetrically**. Common fate (things that move together are perceived as one thing)
means constant mutual influence would fuse the three back into the single field the
preset exists to escape. In music each layer acts on the others at the timescale it
operates at, and those differing time constants are what let the eye read the
couplings as separate effects rather than as one shared multiplier:

| coupling | musical basis | channel | time constant |
|---|---|---|---|
| percussion → all | sidechain / masking: a hit isn't brighter, everything else briefly dims | `alpha *= 1 - duck` (bass ducks 0.55, melody 0.30) | ~45 ms attack, ~0.35 s release |
| melody → bass | a chord change is when the bass must move | `harmonicShift` unlocks the ground's turn-rate cap | ~2 s, rare |
| bass → melody | harmonic function: a melody note means something different over a different bass | melody's noise is sampled in the **ground's rotated frame** | continuous, slow |
| bass → melody | spectral masking: a dense low end leaves the mids no room | `level` squeezes melody's deviation spread | ~20 s |
| melody → percussion | a drum hit has no pitch but is heard against the harmony | on a beat, sparks whose deviation off the wind agrees with the melody's lean are likelier to light — same light, redistributed | per beat |
| percussion → all, **locally** | the cut: a hit is not only heard everywhere, it happens *somewhere* | a lit spark brightens and stirs (widens the deviation of) whatever it passes within `CUT_RADIUS`. Scalars only — see below | while a spark passes, ~0.5 s |

Three of the five are **subtractive** (ducking, squeezing). Stacking three layers of
added light is how you get a white blob under bloom; clearing space reads as an
accent more strongly than adding brightness does anyway.

**The cut cannot push.** Percussion sparks disturbing the layers they pass through
was tried twice as a repulsion — bend the other particles away from the spark — and
both versions wrote visible corners into the long-trailed layers: 1.03 rad of turn in
a single frame taking the nearest spark, 1.38 rad summing all sparks as vectors. The
vector sum was expected to fix it and did not, because *selection was never the
cause*: repulsion from a **moving** point sweeps through 180° as the point passes, and
does so exactly while its weight is highest. That is geometry, not tuning. Expressed
as brightness plus local turbulence instead, both scalars, corners went back to
0.000% everywhere. DESIGN-RULES §1b, fifth occurrence, first one with a number.

**Melody's wander has a reason now.** Its wobble is deliberately near-flat on held
harmony and opens up when the chords actually move, so "when is curling appropriate"
is answered by the music instead of by a constant. Measured on synthetic
progressions: p50 turn/frame **0.0015** on one chord held, 0.0019 at a chord every
8 s, 0.0029 at a chord every 2 s.

**The star.** Every spark in the percussion layer is identical, which is what makes
the layer read as weather rather than as anything happening. On a hit that genuinely
stands out, exactly **one** of them stops being weather: it is thrown across the sky
on its own straight path, fast and bright, and burns out in about 1.3 s.

One, and the reasoning *is* the design. Rarity is the content — a sky where every
star streaks is a snowstorm, and a snowstorm has no moment in it. A single streak
also gives the eye somewhere to *go*: attention can follow one thing and nothing at
all when there are two hundred, which is the difference between watching a movement
and reading a brightness. And because it is a different *kind* of object from the
fields around it, it never has to win a fight for brightness to be seen — which
matters, given how those fights end (DESIGN-RULES §3b). It also sits outside §1
entirely: it is not a competing vector inside the flow, it is a separate object, so
nothing steers it once lit.

**The rule that stops it decaying back into texture:** a bigger moment makes the star
longer, faster and brighter. It never makes *more* of them. That is the exact inverse
of the rest of the layer, where force goes into population, and it is why the two
registers do not compete for the same attention.

Selection is a personal best rather than a threshold: the hit must beat everything
the last few seconds contained, land on a strong beat, and come at least 6.5 s after
the previous star — so a dense passage raises its own bar and a sparse one lowers it.
A spark is promoted only while invisible, so the teleport onto the upstream edge can
never be seen. Measured over the synthetic song: four stars in 160 s, all inside the
loud section, none in the quiet passages, and never two on screen at once.

**Percussion cannot be isolated from this data — so don't try.** The layer lighting
up for things that are not percussion was first attacked by gating ignition on
`attackSharpness`, and that was wrong. `attackSharpness` comes from a *segment's*
`loudness_max_time`, and a segment of a dense mix contains the drum along with
everything else, so its attack time describes the mix, not the drum. There is no
percussion detector in here to find.

What the analysis does report reliably is **which part of the song this is**. So the
beat stays the trigger and the *section* sets the amount: `ignition` rides `level`
and `sectionIntensity` — section-scale signals, since verse-versus-chorus is a section-scale
question and `energy` answers a per-moment one. A quiet passage gets a handful of
sparks; a chorus is allowed to come apart completely. Measured over the synthetic
song shape: 24 sparks lit in the interlude against 217 in the drop, where the layer
emits 371 units of light against bass's 378 and melody's 369 — a co-equal third
voice at full tilt, and nearly absent when the music is.

The dormant pool (`PERC_COUNT` 280) is deliberately larger than the loudest passage
needs. A spark that never lights costs nothing to look at, but a pool that runs out
is a ceiling on the *population* in exactly the way a clamped alpha is a ceiling on
brightness (DESIGN-RULES §3b): at saturation a louder chorus cannot show as more.
The first version of this ran at 90% of its pool in the drop.

**The beat lives in brightness, not in speed.** Percussion's first version made a
hit an impulse — speed proportional to charge squared — so a spark shot off at
~500 px/s and visibly braked to a crawl as its charge decayed, a 14× speed swing
within one spark's visible life. It read as stopping. Speed now varies about 1.7×
and the hit is carried by brightness and width, which can be sharp without the
motion having to be (DESIGN-RULES §5). The layer also had `yAttraction` as a
point-bend toward the cursor; that is a position-dependent target, so every particle
got a different angle, and it was a large part of what read as random direction. It
is a scalar on travel speed now.

**Dynamic range: a drop must not look like an interlude.** The first version of this
preset looked much the same whatever was playing, and measuring it against a
synthetic song shape (quiet interlude → build → drop → outro) put a number on it:
a drop emitted only **1.9×** the light of an interlude, where the audio itself
differs by about ten. Three causes, all of them worth recognising elsewhere:

1. **Constant floors ate the range.** `52 + energy * 85` spans only 1.75× between a
   quiet passage (`energy ≈ 0.06`) and a drop (`≈ 0.56`), because the constant is
   most of the value in both. Low constants and high coefficients instead.
2. **Most of the brightness came from things the music does not touch** — the
   particle's own random `brightness` and local density. Those are identical in a
   drop and in silence. Their weight is down; `glow`, `energy`, `level` and
   `sectionIntensity` carry it now.
3. **Percussion fired a fixed number of sparks per beat**, so a quiet passage lit as
   many as a drop. How many sparks light is now itself a function of loudness, and
   each spark carries the real amplitude of the hit that lit it (`power`, from the
   segment's `loudness_max`) through its speed, width and brightness — so the layer
   has a range of hit strengths instead of one uniform spark.

Now **×4.5** in light and ×6.5 in speed. For comparison, on the same drive every
other preset in the family sits between ×1.48 and ×1.76 — Aurora, the reference, is
×1.58. The flatness was never specific to Layers; it is the family's default, and
`npm run measure` reports it per preset so it stays visible.

**Brightness budget.** Each group has a hard alpha ceiling (`BASS_ALPHA_CAP` 0.34,
`MELODY_ALPHA_CAP` 0.9, `PERC_ALPHA_CAP` 0.95). These were set by measurement, not
by eye: the caps must sit *above* the p95 of each layer's real distribution, or the
clamp flattens the top of the layer and the couplings that modulate it stop being
visible.

Opening the dynamic range immediately proved that rule again from the other side.
Raising the audio coefficients drove the *drop* into the ceilings — 50% of bass
strokes and 40% of melody strokes sitting exactly on their cap, p50 equal to the
maximum — so inside the loudest passage the duck, the cut and `sectionIntensity` all stopped
being visible, and the clipping was itself compressing the drop/interlude ratio.
Pulling the gains back until only ~5% of strokes reach the cap *raised* the measured
ratio. A ceiling being hit is not a safety net doing its job; it is dynamics being
deleted.

**Diagnostic palette.** **ctrl+click** while Layers is on the screen paints each
group a flat identifiable colour — bass red, melody green, percussion blue — and
suppresses the shimmer so the groups cannot swap identities mid-hit. It rides the
same event as Aurora's telemetry toggle, so it needed no new input plumbing. It
exists to answer "which layer is doing that?", not as a palette.

**Gestures, per group.** Bass takes no directional input at all (8 s trails: any raw
per-frame angle response writes a permanent kink — DESIGN-RULES §1b) — the cursor is
a speed scalar there. Melody likewise takes only scalars per particle, and the cursor
reaches it solely through the one shared `melodyTilt`. Percussion is the only group
that takes a per-particle bend, and it can: it is isotropic and its sparks live ~0.3 s,
so there is no long trail to record a kink into and nothing pre-aligned to collapse
into a seam.

### 7.2 Layers II, and what it is built to

`layers2` is the preset under development. It carries the same three groups as
Layers, on the same shared wind, and almost nothing else in common: every mechanism
has been either removed or rebuilt against a measurement. The rules it holds to,
each of which came from something that broke:

**One channel, one driver — and the drivers must share the dynamics.** Length is the
mark's pace, brightness is the loudness, width is how the sound began, position is
its register. Measured phrase by phrase over six tracks, light follows the music at
r 0.88–0.98, motion at 0.64–0.98 and marks at 0.32–0.66 with loudness held still.
Motion used to measure −0.12 to 0.37 — see DESIGN-RULES §13.

**Nothing is assigned into a quantity that is visibly moving.** A hit sets a target;
an eased state chases it. Per-particle speed steps over a whole track: zero, against
3.1 a second in the old preset.

**Every sound is answered before it happens, by as much as that sound needs.** The
lead is `min(0.4s, rise × 0.9)` from the *next* segment, so a mark's shove lands ON
its sound. Only possible because the analysis is a timeline (§1).

**A drop is a big hit and nothing else.** There is no separate drop mechanism. The
moment enters as one term in the size of the event, and everything else reaches it
through the path all sounds take. This is deliberate and it is about the detector,
not the look: we cannot find a drop reliably, and a spectacular effect on an
unreliable trigger is spectacularly wrong every time the trigger is wrong.

**Time is measured in beats of the track, never in seconds.** The loudness window,
the wake's rise and fall, a mark's life. A fixed 0.6s is a different musical thing at
90bpm and at 160.

**The loudness is a centred window, not a follower.** A follower is late by its own
time constant; the analysis is a timeline, so the level half a second ahead is known
and the delay is avoidable. This is peak alignment (DESIGN-RULES §5b) applied to a
level rather than an event.

The three groups and the one coupling between them:

| group | what it is | born from | driven by |
|---|---|---|---|
| bass | the ground | a timer, in place | loudness, the slow background |
| melody | the sheet | a timer, in place | loudness, its own harmonic lean |
| marks | the events | never from a hit — the population is a slow quantity | one mark per sound, shaped by that sound |

**The wake** is the only coupling: a mark turns the field it passes through towards
its own heading and hurries it along, then lets go over a couple of beats. It bends
towards the mark's HEADING and never towards its position — two earlier versions
pushed particles away from the mark and both wrote visible corners, because
repulsion from a moving point sweeps 180° exactly as it passes. And it is applied as
a stored offset under a rate cap, never as an angle blend: blending let a particle
whose wake pointed the other way turn 1.4 radians in one frame.

**And the hand, added 2026-09-02/03.** A mark that does not die: everything a spark
does to the field it passes through, the pointer does too, through the same three
scalars and no others — it lights, it stirs, it hurries. `trailAt` says where it has
been (a ribbon laid by DISTANCE, so a slow hand and a fast one leave the same shape,
and a still hand leaves none), `baton`/`hand` say how hard it is working. The field
reads `baton` (a bar), the marks read `hand` (a beat), so one gesture stays two
things instead of fusing into one knob. A click is a glow and a ring, and the ring is
LIGHT ONLY — it was briefly in the turbulence and put the first three turns over
0.3 rad this preset has ever measured into a single run.

---

### 7.3 Flow Field, rebuilt and then archived

Rebuilt on 2026-09-17 and archived on 2026-09-20, on the listener's verdict: *"it is
basically Aurora, not Flow Field, and with no new features at all — it does not stand at
the same level as Layers."*

Both halves were true, and the second one turned out to be measurable. Its skeleton was
Aurora's — one shared wind, a bounded per-particle deviation, sampled in the wind's own
rotated frame for the sheets variant — so "it is Aurora" is a description of the code,
not an impression. And the one thing that WAS new, a band of light across the wind at
each sound's register, measured at **26% of all the light in the picture**.

That number is the lesson, and it is not the one §12 usually teaches. The mechanic was
not too small to see: a quarter of the picture was going through it. It was too diffuse
to ATTRIBUTE — brightening a stripe of a field that is already moving reads as "it is
brighter over there", never as "that was a sound". **A change with no author is not an
event**, which is exactly what the first conducting build was told, in a preset that had
no gestures in it at all.

What survives is in `archive/flowfield.ts`, and the note at the top of that file says the
same thing at more length. If a calm counterpart to Layers II is ever wanted again, it
has to start from a different MECHANISM: a second noise field will always be a worse
Layers II.

---

### 7.4 Smoke, and what a fluid costs

A port of Jos Stam's Stable Fluids, unchanged in its mathematics: advect the velocity
along itself, project it back to divergence-free, advect the dye along the result. The
grid is 192 across (rows follow the canvas aspect so cells stay square), the pressure
solve is 18 Jacobi iterations, and a frame costs **3.8 ms** at 2560×1440 against a
16.7 ms budget.

What the music does, one driver each: a sound is a **puff of dye and an impulse of
force**, thrown in `min(0.4 s, rise × 0.9)` BEFORE the sound at its own place on the
register axis; the **wind's speed is the loudness** and nothing else; the brace raises
the dissipation so the room thins on the way in; the release is one large injection
through the same door rather than a mechanism of its own.

Six things were measured rather than assumed, and each one was a fault first:

1. **A wind is a velocity the field relaxes towards, not an acceleration.** As a pure
   acceleration it had no steady state: the field integrated it for three minutes and
   reached 273 cells a second, crossing the whole room twice a second, and every puff
   was smeared before it could be seen.
2. **It relaxes the MEAN, not every cell.** Relaxing each cell erases the eddies at the
   same rate as it corrects the drift, so the room could follow the music or remember a
   sound but never both — the flow tracked the loudness at r 0.45. Splitting the field
   into its mean and its fluctuations gave r 0.99.
3. **The light's driver is the dye and only the dye.** With the loudness in the gain as
   well, the song's dynamics were squared: on a track whose music spans ×4.1 the light
   spanned ×28.
4. **A floor under every puff.** The room's density against the music was a straight
   line with a NEGATIVE intercept, and a line through below zero exaggerates every ratio
   on it — that is how a ×1.76 song became a ×3.07 room.
5. **Beer–Lambert, not a clamp.** `1 - exp(-density)` is what smoke actually does and it
   is a ceiling that is approached rather than arrived at (§3b, in a pixel).
6. **The shear is what makes it smoke, and it costs correlation.** Measured on one track
   at one grid, changing nothing else: no shear r 0.86 and every plume a round blob; a
   quarter of the wind r 0.79 and plumes torn into filaments; half the wind r 0.64.
   Mixing makes the room's density depend on its own history. There is no free version.

Where it ended up, over three real tracks: light follows the music at **r 0.79–0.87**
(0.73 on the sparse one, where the room genuinely empties), the flow at **r 0.97–0.99**,
and the picture's range is **0.2–0.9 of the music's own** — it understates rather than
exaggerates, which is the safe direction. Interlude to drop: ×2.31 of light, against
Layers II's ×2.51.

**And every sound has a MOMENT, which is what the first build did not have.** The verdict
after a night with it was *"watchable, the smoke curls nicely — but only when you move
the mouse; the reactivity to the music is lacking"*, and the measurement agreed in a way
that was worth more than the complaint: the music's own puffs were **39% of all the light
in the room**, so it was not that the sounds were absent. They had no attack. A puff
entered a fog of the same density and became part of it, while the hand - local, strong,
instant - was the only thing that ever *happened*.

So the fluid now carries a second field. Dye is what the room HAS; **heat** is what just
happened in it: injected with every puff, tighter than the smoke around it, advected by
the same velocity field and gone in a fraction of a beat (the dye lives several). It is
drawn additively in its own hotter colour, so a sound is a flash that fades rather than
one more contribution to the fog — and because it is additive, a sound arriving into an
empty corner of the room is visible there too, which a multiplier on the dye could never
be. Puffs are also a good deal bigger: at 3.2 cells on a 192-wide grid a sound covered
2.6% of the width, and thirty-nine per cent of the light spread over a hundred merging
blots of that size is a fog by construction. Measured after: the brightest part of the
picture swings **×1.4 within a second and a half**, in a sawtooth whose every tooth is a
sound — where before it barely moved at all.

**The hand stirs.** A tangential velocity around the pointer, gaussian in the distance,
strength `baton` and a sense that is a constant — so no part of the direction comes from
the input, nothing converges, and the dye is never touched. Vorticity confinement was
tried first, as the more conservative thing, and measured at **+4% of the room's flow
with no change in the light at all**: amplifying zero is zero, and the fluid under a hand
is mostly irrotational. The §1d test passes — at rest, sweeping, and teleporting to a
random point every frame all produce the same light and the same worst one-frame change.

---

### 7.5 Plate, and the harmony as a shape

Chladni figures, from the closed-form square-plate solution. Sand walks down the
gradient of |S| — towards where the plate is still — and jumps in proportion to how hard
the plate is ringing where it stands. That migration IS the figure appearing; it is the
physics, not a decoration.

It exists to answer the question Layers II admits it cannot: **register and harmony**.
Twelve modes, one per pitch class; the chroma's tonal centre chooses where on the
coarse-to-fine axis the plate rings and the register chooses how fine that is, while the
loudness decides how hard the sand jumps. A hit is a shake, never a new figure.

A frame costs **2.8 ms** with 12 000 grains: the field is evaluated on a 96×96 grid from
cosine tables and the grains read it by interpolation.

Four faults, all of them measured, and the last one is about the DATA rather than the
code:

1. **The formula's own diagonal.** The textbook combination is antisymmetric, so it is
   zero along x = y for every mode at once — the sand piled onto the same bright diagonal
   in every frame of every track. The general combination of the degenerate pair, with a
   fixed mixing angle per mode, removes it.
2. **A flat sum of twelve modes is not a figure.** The nodal set of a generic
   superposition is a scatter of unrelated curves. What makes a figure is one or two
   modes ringing, which is why the harmony picks a PLACE on the axis rather than lighting
   all twelve.
3. **The axis holds, and the harmony unlocks it.** Chased continuously, the figure was
   always slightly morphing and a chord change was not an event in it — measured at
   ×1.01. A rate cap unlocked by harmonic movement is the §11 shape for this, and it took
   the resting rate of change down by two thirds.
4. **`harmonicShift` and the chroma's tonal centre are not the same event** — see
   MEASUREMENTS §2.6. The figure still does not answer a `harmonicShift` spike (×1.02
   after the fix), and that is because the two signals genuinely describe different
   things. What the fix did buy is a figure that is still between changes rather than
   permanently drifting.

**The plate itself is drawn, as of 2026-09-20, and that is what made it legible.** The
verdict on the first build was *"I did not understand what you were going for"*, and it
was fair: the only thing on screen was sand, and sand by itself is a scatter of dots on
black with nothing to say where it came from. A Chladni figure is sand ON something. The
field is now rendered behind the grains as a faint wash — brightest where the plate moves
most, black along the nodal lines, which is exactly where the sand then piles up — so the
picture explains itself: you see the standing wave, and you see the sand finding the
places where it is still. It has to stay a HINT: at the first coefficient the wash came
out as bright wallpaper with the sand as a thin outline on it, which is the same fault
pointing the other way.

**And the plate is struck.** Everyone has seen the video: the tone changes, the sand
LEAPS and re-forms. That leap was missing entirely — the sand only jittered in place, so
nothing on screen ever happened at the moment a sound did. `shake` rises on the frame of
a hit and falls over about a beat, and it multiplies the drive, so a kick throws the
grains off the lines and they walk back. It reads the hit's own size and **not** the
passage's level: gated by the loudness as well, it measured 0.148 on a quiet stretch — a
seventh of a shake — because the level was already in the term underneath it. A quiet
passage still has kicks, and they should still jump.

Its light is flat by design (×1.23 interlude to drop): what this preset says, it says
with the SHAPE. That is a channel nothing in `music-lab.js` or `measure-motion.js` can
read, so the preset publishes `figureChange` through the diagnostics channel and the
measurement is made on that.

---

## 8. Verification

```bash
npm run typecheck    # tsc --noEmit, with noUnusedLocals/noUnusedParameters
npm run check        # drives all 5 presets against a fake canvas
npm run measure      # what the presets actually DO - emission, turn continuity, coherence
npm run structure    # does the chorus detector find the choruses? scored against labelled tracks
npm run build && spicetify apply
npm run live         # the standalone system-audio window (§9)
```

`check` asks "is it broken"; `measure` asks "is it what you meant". It drives every
preset for a minute and reports total light emitted per frame, per-**particle**
heading change per frame (array order is stable, so index N is the same particle
until it respawns), and how much the particles agree on a direction.

Its fake audio plays a I–IV–V–ii progression, one chord per bar, **not** twelve
random numbers per segment. That distinction turned out to matter enormously: with
random pitches, consecutive segments share no harmony, so `harmonicShift` sits pinned
at its maximum for the entire run and every harmony-driven measurement reads a
permanent chord change. Layers' melody measured **6× calmer** the moment the drive
held an actual chord. A harness that is not musical does not measure a music
visualizer.

The per-particle part matters more than it sounds. A population average can swing
wildly while every individual filament stays perfectly smooth — measuring the
average first sent one investigation down entirely the wrong path. What the eye
reads as "it kinked" is one particle turning a lot in one frame, so that is what to
measure. The `corners>20°` column is the headline: Aurora and Layers are at 0.000%.

`check-presets.js` asserts every number handed to the canvas is finite and
in-range, and that **a paused frame issues byte-identical calls to the frame
before it** — the freeze-on-pause invariant. It runs each preset both with and
without analysis data (local files and podcasts have none).

`npm run preview` builds a browser harness that renders presets against fake
audio, for when a change actually needs to be *seen*. Skip it during live
tuning — the user is watching the real thing.

**Three things in that harness were lying, all found on 2026-09-17, all of them making
every preset look worse than it is.** They are worth knowing because a tool that
understates the picture is worse than no tool: it turns a fine preset into a bug hunt.

1. **The rAF loop did not continue from the warm-up.** `?warmup=N` ran N frames on its
   own accumulator while the render loop timed from page load, so the first real frame
   after a warm-up handed the conductor a `progressSec` fifteen seconds in the *past*.
   `dt` is clamped at zero from below, so every frame after that had dt = 0: nothing
   moved, every stroke had zero length, and `fadeTrail` went on clearing until the canvas
   was black. Every headless screenshot this project has ever taken was of that.
2. **The fake track was never normalised.** `normaliseCurve` is what puts a track on the
   0.06..0.62 scale every preset is tuned against; the harness fed its curve straight in,
   so `c.loudness` sat around 0.1 — the bottom of the range — and the picture was dark and
   slow. `normaliseCurve` is exported now, and both the harness and `music-lab.js` use it.
3. **`warmup=900` lands in the quietest moment of the fake track.** Its loudness swings
   0.11 → 0.61 on a ~21 s period, and 900 frames is 15 s, which is a trough. Use
   **`warmup=1260`** for a representative frame, or step through several.

And a fourth, in `music-lab.js`: its "marks" column sliced the stroke list at a hardcoded
400, which was right for the window it was first run in and wrong at any other size — at
2560×1440 the first mark is stroke 1333, so everything it called a mark was the tail of
the sheet. It now derives the split, and takes `--preset=<id>` and `--variant=<n>`.

**Both measuring harnesses were blind to anything that is not a stroke.** `music-lab.js`
and `measure-motion.js` built their numbers from `moveTo`/`lineTo`/`stroke` only, so
Smoke (one `putImageData` a frame) and Plate (one small `fillRect` per grain) measured as
exactly zero light — the tool that answers "is it what you meant" could not see two of
the five presets at all. Both now convert a pixel buffer's luminance and a rect's
area × alpha into the same unit a stroke reports. The full-frame fill that clears a
canvas is excluded, or the clear would be most of the light.

**And `check-presets.js` could not see inside a simulation.** A `Uint8ClampedArray` turns
a NaN into 0 on the way in, so by the time a bad value reaches an ImageData the evidence
is gone; the freeze-on-pause test, meanwhile, was comparing two identical
`[object Object]` strings. It now hashes the pixels (FNV-1a) so the frozen-frame test
covers them, and asserts on `publishDiagnostics` — a slot in `flowfield-common.ts` where
a preset with state that is not visible in its draw calls reports that state once a
frame. Both halves were verified by deliberately breaking a preset: a NaN in the fluid is
caught at the frame it happens, and a preset that keeps simulating while paused is caught
as "kept animating while paused".

---

## 9. The standalone window

`npm run live` → <http://localhost:8790/live.html>. The same five presets, driven
by whatever the computer is playing, in a plain browser window rather than inside
Spotify. Built for watching alongside something else.

**Nothing in `src/presets/` changed to make this exist**, and that is the point of
§4.1 being a seam. `src/live-audio.ts` analyses system audio and emits the *same
`TrackAudioData` shape* — beats, segments, loudness curve — only grown one frame at
a time instead of arriving precomputed. Every lookup in `audio-data.ts` is a binary
search over those arrays, so growing them live works unchanged, and the arrays are
trimmed from the front to bound memory.

| Spotify gives | live derives it as |
|---|---|
| `loudnessCurve` | RMS → dB → the same `10^(dB/20)` conversion, so `energy` lands on the scale the presets were tuned against |
| `segments[]` | spectral-flux onsets against an adaptive threshold |
| `loudness_max_time` | the flux-to-level ratio at the onset — a transient dumps far more flux than a swell, so attack character is measured, then encoded back into the field the conductor reads |
| `pitches[12]` | FFT bins folded onto pitch classes (65 Hz–5 kHz), normalised to peak 1 as Spotify does |
| `timbre[1]` | spectral centroid, log-scaled to ±100. The other eleven coefficients are never read by anything, so they are not invented |
| `beats[]` | the strong onsets |
| album colour | there is none — the accent hue comes from the chroma's tonal centre, eased |

Two things are genuinely different and worth knowing:

- **The future is gone.** §1 lists "the whole track's structure is known in advance"
  as the reason motion can anticipate rather than react. Live analysis is causal;
  everything trails the sound by about one analysis window (~85 ms).
- **Loudness is relative, not absolute.** Spotify reports absolute loudness; a live
  tap reports whatever the system volume slider left, and RMS sits 10–14 dB under
  the peak-ish `loudness_max` the tuning assumes. A slow auto-gain maps a decaying
  recent peak to about −7 dB. It decays at only 0.25 dB/s — deliberately slower than
  musical structure, since it is there to cancel the volume knob and must not
  flatten the drop-versus-interlude range (§7.1).

**Tried inside the plugin, and rejected.** For tracks whose analysis is missing, the
same live tap was wired into the Spicetify app behind a button. Two things were
learned and are worth not re-learning:

- there is **no media element to tap** in the Spotify client — a probe found zero
  `audio`/`video` nodes, so playback is decoded natively and
  `createMediaElementSource` has nothing to attach to;
- `getDisplayMedia` **does** work inside the client, contrary to expectation, and
  the capture ran.

It was removed anyway, on the only evidence that matters: it looked worse. Live
analysis reproduces *loudness* well, and that is all. Spotify's beats are a
tempo-tracked grid; spectral-flux onsets fire on vocals and synths alike, so
percussion triggers on noise. Spotify's segments are perceptual boundaries with real
loudness envelopes; flux peaks are not. The result does not behave like a normal
track, and no tuning closes that gap — the precomputed analysis is the product's
actual moat (§2). The standalone window keeps it because there it is the only option
there is.

Audio arrives via `getDisplayMedia`: browsers will not hand out system audio on its
own, so it comes attached to a screen share — **Entire Screen** with **Also share
system audio** ticked. The video track is requested at the lowest rate accepted and
never looked at; it is the price of the audio.

---

## 10. Known state and open threads

**Where the work is (2026-09-16):** `layers2`. It began as a byte-for-byte copy of
`flowfield-layers` so that the LOOK would survive while the insides were replaced,
and has since been hollowed out mechanism by mechanism, each removal or rewrite
checked by measurement. What is gone: the gesture layer, chaos/order, the star, the
separate drop mechanism, `c.glow`/`c.level`/`c.sectionIntensity`/`c.energy` from
every channel that moves or lights, and every value that was ever assigned straight
into a moving quantity. What is new: hits from `rhythmstring` (§4.8), a per-sound
shape, marks placed by register across the wind, a wake from the marks into the
other two layers, and every time constant expressed in beats of the track.

**Recently shipped:**
- Conducting, sixth attempt (2026-09-02/03) — `baton`, `hand`, `trailAt`,
  `rippleAt`. See §7.2 and DESIGN-RULES §1d. It first shipped measuring 0.0–4.2% of
  the light on screen, i.e. under this project's own threshold for invisible (§12),
  and was fixed in three places: reach (×10 in area), depth (coefficients ×2), and
  the layer it reaches — it was lifting only the ground and the sheet, the two
  dimmest things in the picture, while the marks were deaf to it. After: 18.3% at a
  big sweep, 10.8% on a click once a bar, 0 turns over 0.3 rad in every trace.
- `layers2` — see above and §7.2.
- `src/rhythm.ts` — `rhythmstring` decoded at track load into broadband onsets.
- `music-lab.js` — reads a dump as music and measures the picture against it.
- `flowfield-layers` — the layered-groups preset. See §7.1. Frozen as a reference.

**Recently fixed:**
- Beat shimmer was a full R/G/B channel swap at `pop ≈ 1` — read as a glitch
  flash. Now capped at a 0.4 blend, in the one shared function.
- Aurora's cursor response no longer sets particle direction at all; cursor
  proximity widens the noise deviation (turbulence) instead. See
  [`DESIGN-RULES.md`](DESIGN-RULES.md) §1 for why every direction-setting
  approach failed.

**Open:**
- Cursor interaction in Aurora is still not where it should be. The turbulence
  approach is the current hypothesis and has not yet been validated against a
  fresh telemetry recording.
- `attackSharpness`, `harmonicShift` and `gustCoherence` are available to every preset;
  `gustCoherence` is now read by nothing at all, since the presets that used it are
  archived.
- **`getAudioData` can return a payload the adapter cannot read** — and the reason
  the message is `segments is not iterable` rather than the friendly one is a
  BUG IN THE ORDER OF `loadTrackAudioData`, found 2026-09-16. The guard that turns
  the endpoint's `{ code, error, message }` reply into a readable error sits three
  lines BELOW `buildLoudnessCurve(analysis.segments)`, which iterates those
  segments. So the throw always comes from the curve builder and the guard is dead
  code. Confirmed: `for (const segment of segments)` over a non-iterable produces
  exactly that string. Moving the guard above the curve is the whole fix — after
  which the real question (what the endpoint actually returned) is answerable.
- **A track with no analysis looks broken rather than plain.** `getAudioData` is an
  undocumented internal endpoint and does fail, and when it does `currentEnergy`
  falls back to a sine, `beatHit` never fires so percussion never appears, and
  `attackSharpness`/`harmonicShift`/`brightness` sit at zero — small particles
  drifting in slow waves, identically on every preset, because the cause is
  upstream of all of them. The request is now retried once and the failure is
  announced instead of swallowed. Whether the fallback itself should be better than
  a sine is open.
- `tatums` is still unread. `sections` also carries `key`, `mode` and its own `tempo`,
  none of which anything uses yet.
- Only Layers reads `anticipation`/`impact`. The other seven ignore the boundary
  entirely.
- **The whole family is flat across a song.** Every preset except Layers emits only
  1.5–1.8× as much light in a drop as in a quiet interlude (`npm run measure`).
  They are bright constantly — Aurora sits at 867 units in an interlude against
  Layers' 199. Whether the older presets should be opened up the same way is
  undecided.
- **Direction: the base must stand without input.** The Conductor is due to be
  reworked with its influence likely reduced; the visual is expected to be
  excellent with the cursor untouched. All measurement here already drives a still
  cursor at screen centre, so every number in this document is the no-input case.
  Do not deepen gesture mechanics until that rework has a shape.
- **Layers, first look done.** Brightness confirmed fine and its ceilings are to be
  kept as headroom for future brightness effects. Direction is fixed (one shared
  wind). Still open by the user's own list: the three groups differ **too
  cardinally** in stroke form, lifetime and possibly size — to be judged with the
  diagnostic palette on. Melody remains ~3× twitchier per particle than Aurora
  (p50 0.009 vs 0.003 rad/frame, no discontinuities); unclear yet whether that
  reads as character or as noise.
- `flowfield-chroma` turns more than 20° in a single frame on **1.6%** of
  particle-frames, and `flowfield-curl` on 0.04% (peaking at 3.10 rad, nearly a
  reversal). Found by `npm run measure`, not yet investigated — same class of
  defect as the one DESIGN-RULES §1c describes.
- `visualizer-poc-*` CSS class names and the `spicetify-visualizer-poc:preset`
  localStorage key still carry "poc". Renaming the CSS is free; renaming the
  storage key silently resets the saved preset once.

**Found in the audit of 2026-09-16 and fixed the same night.** Each was measured
before the fix and measured again after it; both numbers are in the entry. None of it
has been judged by eye yet.

- **FIXED — a lit spark outside the drawn pool was lighting and combing the other two
  layers.** `cutters` filtered the WHOLE `perc` array while the draw loop covered only
  the first `inSky` of it, and `inSky` moves with the slow band: about 22 slots leave
  the visible pool per minute (p50 over 91 dumps). A spark stranded on the far side
  was never drawn and never aged again, so its charge FROZE and it went on cutting
  from a fixed point until the pool grew back over it. Measured on the real preset,
  three tracks, three minutes each: **17–46% of frames carried at least one, up to
  four at once, 2.5–3.5% of all the cut weight** — light with nothing under it, the
  exact class of fault this preset has spent three rounds removing. `inSky` is now
  computed once at the top of the frame where both loops read the same number,
  `cutters` is built from the drawn range only, and everything outside it ages on its
  own clock rather than freezing mid-burn — otherwise it resumes half-lit at a stale
  position when the pool grows back, which is an event with nothing before it (§5c).
  Re-measured on the same three tracks: **0% of frames, on all three.**
- **FIXED — the wake's two components ran on different clocks.** In the bass loop
  `p.wx` eased at the beat-relative `wakeRise`/`wakeFall` and `p.wy` at a hardcoded
  `5.5`/`1.2`, and the melody loop used `5.5`/`1.2` for BOTH: the "every time constant
  in beats of the track" conversion had reached one of four components, and two axes
  of a stored VECTOR converging at different rates rotate the wake direction while it
  rises and falls (~9° at 60 bpm, nothing at 120 — the tempo it happened to be checked
  at). Both layers now take one step for both axes. Verified on real music with the
  random stream pinned so the two builds are comparable frame for frame: per-particle
  turn p50/p95/max identical to three decimals, zero turns over 0.349 rad either way.
- **FIXED — `bestHold = Math.max(1, ...holds)` normalised half the corpus against its
  own best**, which is what the comment above it says was removed. 48 of 91 tracks
  have a best hold over 1, and for those every other moment was divided by it: 47 of
  345 moments more than 0.15 smaller than the fixed reference, worst 0.61 — on
  Ecophony Rinne a moment that should be full size shipped at 0.39. `size` is now the
  hold, clamped to 1, and nothing else. Median moment size over the corpus 0.43 →
  **0.50**, with the same 46 of 91 tracks reaching full size, which is exactly what a
  fixed reference is for. **This is the one change likely to be audible as a
  difference in the drop:** more moments now arrive at their real size.
- **FIXED — `createChromaTracker` eased per FRAME, not per second.** `bands[i] +=
  (target - bands[i]) * 0.12`, no `dt` anywhere in it: the only time constant in the
  project that changed with the frame rate, and it feeds `melodyTilt`, which is
  geometry. Now `Math.min(1, rate * dt)` like everything else, at 7.2/s — identical to
  the old behaviour at 60 fps and no longer a different picture on a 120 Hz screen.
- FIXED (latent, never reachable on the 91 dumps): `inSky` exceeded `perc.length`
  once the slow band passed 0.867, and `perc[pi]` would then have been `undefined`.
  Measured maximum slow band across the corpus is 0.564, so it could not happen on
  this music. One `Math.min`, because "cannot happen on the corpus" is not "cannot
  happen".
- FIXED — `music-lab.js` said it applied "the same per-track normalisation the preset
  sees" and did not: 0.12..0.85 against `normaliseCurve`'s 0.06..0.62. Correlations
  survive an affine change; the RANGES quoted from `--picture`, and the behaviour of
  the preset it drives under it, do not. **Every `--picture` range in these documents
  was taken through the wrong stretch and wants re-taking.**
- FIXED — `signal-scope` had no lane for `loudness` (which sets all three speeds),
  `windup`, `baton` or `hand`. All four added, sixteen lanes now, with `loudness` next
  to `energy` on purpose: telling the level from the sawtooth is the whole point.
  Nothing was removed — `glow`, `level` and `trend` are dead to `layers2` and live for
  other presets.
- OPEN: the graphify knowledge graph in `graphify-out/` is from 2026-08-27, before
  the whole of Layers II, and the `graphify` CLI is not installed — so the rule in
  CLAUDE.md that says to query it before reading code cannot be followed. Reinstall it
  or drop the rule; a stale graph is worse than no graph.
- OPEN: `describeLeadIn` looks back eight seconds, so a run-in longer than that
  reports exactly 8. Since the gap fix that is **19% of all moments**, where the
  number is the width of the window rather than a measurement. Widening it means
  moving the baseline too, which is taken 9–16 s back.
