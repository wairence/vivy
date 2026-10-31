# Data

What vivy reads, how far each number can be trusted, and what the code derives from it.

There are two layers. The first is what Spotify's audio analysis contains. The second is what `src/audio-data.ts`, `src/track-structure.ts`, `src/rhythm.ts` and `createConductor()` in `src/presets/conductor.ts` compute from it.

Trust claims are measured on analysis dumps saved from real tracks (`analysis-dumps/`, not in the repository; a dev build saves one per track played while the dev server, `npm run preview`, is running). Each claim names its base. 81 dumps is 67 094 segments and 35 176 beats, masters from -1.9 dB to -19.8 dB, tempi from 66 to 200 BPM. Where a smaller base is named (25 tracks, 19 dumps), the claim comes from the earlier, smaller set. Where a field has never been measured, this file says so.

## 1. Where the data comes from

One request per track, for the whole track, before it plays. The analysis is a timeline, not a live feed. Anything can be measured over the entire track at load, including the part that has not played yet. Every mechanic that acts before a moment (a mark lit before its sound, the brace before a drop) exists because of this.

`loadTrackAudioData(uri)` in `src/audio-data.ts`:

1. `Spicetify.getAudioData(uri)` is tried first.
2. If that does not return an object with `segments`, the same endpoint is fetched directly (`fetchAnalysisDirectly`): `audio-attributes/v1/audio-analysis/{id}` on `spclient.wg.spotify.com`, with the bearer token from `Spicetify.Platform.AuthorizationAPI`. The wrapper picks its request path from the client's version string, and on Spotify 1.3.0 that comparison takes the legacy path.
3. Both paths can resolve with an error object (`{ code, error, message }`) instead of rejecting. The shape is checked before anything reads it, and the error text names both failures.

`ui/use-track-data.ts` wraps this with a 10 s timeout, one retry after 1.2 s, a cache of four analyses and a prefetch of the next queued track.

### When there is no analysis

Analysis is only requested for `spotify:track:` URIs. Local files, podcast episodes and ads have none, and some real tracks answer 404.

- Empty or failed analysis: `loadTrackAudioFeatures` asks the sibling `audio-features` endpoint. It returns one summary row per track: tempo, loudness, key, mode, energy, danceability, valence.
- If that works, `trackDataFromFeatures` builds a `TrackAudioData` from it: a beat grid from the measured tempo (confidence 0.6, starting at zero, so it drifts against the mix), a loudness curve flat at the track's loudness (clamped to -40..0 dB), no segments, bars, sections or moments. The track gets a pulse at the right tempo and nothing else. The audio-features row describes the whole track, not the moment. `valence` and `energy` are returned but nothing reads them.
- If that fails too, `audioDataRef` stays `null` and a notification says so. Presets are called with `audio: null`.

Both cases are announced with `Spicetify.showNotification`. Picture behaviour with no segments: Ridgeline draws flat rows, Drift lights no marks. See ARCHITECTURE.md.

## 2. What Spotify gives us

### 2.1 `segments[]`

A segment is a stretch the analyser treats as acoustically uniform. It is not a note or a beat. A busy passage produces many, a held chord few.

Rate: 2.3 to 4.8 per second depending on the track. Duration p5/p50/p95 = 0.10 / 0.23 / 0.59 s. Nothing read from segments can respond faster than about a quarter of a second.

`loudness_max` (dB, peak inside the segment)

- Trust: high. p5/p50/p95 over all segments = -26.7 / -6.1 / -0.2 dB.
- The scale is mastering, not music. On 19 tracks the share of segments above -5 dB ranges from 0% to 97%.
- Use it relative to the track's own distribution (`hitScale`, `normaliseCurve`), never against a constant. Absolute thresholds failed three times.

`loudness_max_time` (seconds into the segment at which the peak falls)

- Trust: low for what it is wanted for. It reads as attack time, but p50 = 0.043 s, p95 = 0.161 s. The share of segments peaking within 60 ms is 49 to 92% of all segments and 28 to 100% among the loudest tenth, and the direction differs per track (on one track loud segments are less sharp than average, 28% against 58%; on another slightly more, 100% against 92%).
- A segment of a dense mix contains the drum together with everything else, so its attack time describes the mix. Percussion cannot be isolated from this field. Three attempts to do so were dropped.
- Use it as a character input (how abrupt), not as a classifier.

`loudness_start`, `loudness_end`

- The idea of reading `loudness_end[i]` against `loudness_start[i+1]` as a cut detector does not hold. The gap has a median of 6 to 30 dB depending on the track, because a segment ends where the previous sound has decayed and the next starts at its own onset. `loudness_start` correlates with `loudness_max` at 0.61 to 0.77.
- `loudness_end` is zero on 93.7% of all segments. It is read in exactly one place, the last point of the loudness curve.

`pitches[12]` (chroma)

- Normalised: the maximum is exactly 1.000 in all 14 930 segments of the 19-dump set. It is a shape with no magnitude.
- Much flatter than it looks. The strongest class holds a median 23% of the total (a flat distribution would be 8.3%). Consecutive segments have a median cosine similarity of 0.79.
- At bar scale, raw, it is nearly useless: cosine between bars at least four apart has a median of 0.77 to 0.97 per track, with the whole p5-p95 band 0.13 wide on several. After subtracting the track's own average chroma (mean-centring) the same pairwise median is about -0.04 with a spread of 1.08 to 1.46. Any comparison of distant points in a track needs mean-centring.
- Use it as a harmonic profile. Not as a magnitude, and not as "which note is playing".

`timbre[12]` (67 094 segments)

| coefficient | p5 to p95 | spread | r with `loudness_max` |
|---|---|---|---|
| [0] | 37 to 57 | 20 | 0.95 |
| [1] | -75 to 116 | 191 | 0.38 |
| [2] | -76 to 86 | 162 | 0.08 |
| [3] | -65 to 61 | 126 | 0.05 |
| [4] | -21 to 76 | 97 | -0.10 |
| [5] | -67 to 28 | 95 | 0.07 |
| [6] | -44 to 42 | 86 | 0.08 |
| [7] | -39 to 34 | 73 | 0.05 |
| [8] | -34 to 25 | 59 | 0.03 |
| [9] | -27 to 30 | 57 | 0.06 |
| [10] | -40 to 16 | 56 | -0.07 |
| [11] | -23 to 25 | 48 | -0.09 |

[0] is loudness again. [1] is the widest and reads as brightness. [2] and [3] are close to independent of loudness. Everything from [5] up is narrow and correlates with nothing. Only [1] is read by the live code.

`timbre[1]` describes the whole segment, so the whole mix, not one sound. Consecutive hits differ by 19% of its range at the median, and any ten seconds covers 68% of it. The raw values are bell-shaped. Placing marks linearly on it left them bunched in the middle (spread 0.27 of the half-width against 0.58 for a uniform spread), so it is used by rank within the track (spread 0.42 to 0.50).

`confidence`

- Present and uses its whole range: p5/p50/p95 = 0.07 / 0.54 / 1.00 over 67 094 segments. It reads as how well defined the segment is. A low-confidence segment is a blurry one, not a wrong one.
- Ridgeline uses it as the weight of a row (see ARCHITECTURE.md). It is optional in the type; Ridgeline falls back to 0.5 when it is absent.

### 2.2 The grids: `bars[]`, `beats[]`, `tatums[]`

Three nested grids, each `{ start, duration, confidence }`.

`bars[]`

- The grid is steady. Per-track bar duration varies by only 0 to 4% around the track's median (median bar 1.68 s).
- `confidence` is a poor judge of it: p5/p50/p95 = 0.12 / 0.47 / 0.80 on grids that are demonstrably regular. Read the geometry, not the self-report.
- A bar start coincides with a segment start only 28 to 68% of the time (median about 45%). The grids are independent, so always search for the nearest bar start, not the bar that contains a time.
- 100% of bar starts land within 30 ms of a beat, on all 81 tracks.

`beats[]`

- Beats per minute lands within a few percent of the reported tempo almost everywhere. One track in 81 reads 146 against a reported 168 (a half-time or triplet reading).
- Confidence over 35 176 beats: p5/p50/p95 = 0.12 / 0.44 / 0.81. A beat start coincides with a segment start only 7 to 47% of the time.
- The confidence predicts whether the grid can be trusted: the correlation between a track's median beat confidence and how strongly its `rhythmstring` events cluster on its beats is r = 0.50 over 81 tracks. The four tracks whose events look random against their own grid are the four with the least confident grids.
- `beats.length === 0` has happened on real tracks.

`tatums[]`

- Exactly two per beat on all 81 tracks, at 66 BPM and at 200 BPM alike. A tatum is a half-beat and carries no extra rhythmic information.
- `TrackAudioData.tatums` carries them. Nothing reads them.

### 2.3 `sections[]`

`{ start, duration, confidence, loudness, tempo, key, mode, time_signature }`. Spotify's own division of the track into large blocks.

- `loudness` spans a real range within a track. The spread (max minus min) has p5/p50/p95 = 3.5 / 12.6 / 35.7 dB over 25 tracks of 8 to 11 sections.
- `confidence`: p5/p50/p95 = 0.10 / 0.59 / 1.00.
- `time_signature` disagrees with itself on 27 of 81 tracks (sections marked 3 and 5 inside a track labelled 4/4). A track claims a median of 4 distinct keys, up to 8. These read as a low-confidence estimator changing its mind each block, not as modulations.
- `tempo` is stable and agrees with the track (within 1 BPM across every section measured).
- The boundaries are a timbral segmentation, not a map of song form. A boundary is not a chorus. On one reference track the nearest section boundaries sit 11 s before one chorus and 2 s after another.

### 2.4 `track`, the summary

26 fields: `duration`, `loudness`, `tempo`, `time_signature`, `key`, `mode`, a confidence for each of those four, `end_of_fade_in`, `start_of_fade_out`, `num_samples`, `analysis_sample_rate` (22050), `analysis_channels` (1), `offset_seconds`, `window_seconds`, an empty `sample_md5`, four version numbers and four long encoded strings. The adapter's declared type has only `tempo` and `duration`; the rest travels untyped in `TrackAudioData.trackInfo`.

Confidences across 25 tracks (min / median / max):

| field | min | median | max |
|---|---|---|---|
| `tempo_confidence` | 0.00 | 0.63 | 1.00 |
| `time_signature_confidence` | 0.03 | 1.00 | 1.00 |
| `key_confidence` | 0.00 | 0.48 | 0.98 |
| `mode_confidence` | 0.15 | 0.51 | 0.80 |

Metre is known outright on most tracks and tempo usually is. Key and mode are about a coin flip. The first three dumps measured the opposite (tempo confidence 0.17 to 0.34): three tracks is too few.

`start_of_fade_out`: 77 of 81 tracks report a real fade, median 6.8 s long (p5/p95 = 2.7 / 14.4 s). The other four set it equal to the duration. Nothing reads it.

Read from `trackInfo`: `key` (the home key, by `keyHueAt`) and `rhythmstring`. Read from `track`: `tempo`.

### 2.5 The encoded strings and `rhythmstring`

`codestring`, `echoprintstring`, `synchstring` and `rhythmstring` are zlib data in URL-safe base64 (they begin `eJx`). `codestring` and `echoprintstring` are acoustic fingerprints, 4k to 24k characters each, of no use here; the dev dump strips them. `synchstring` has never been examined.

`rhythmstring` decodes to whitespace-separated integers: `sampleRate hopSize bandCount`, then for each band a count followed by that many gaps in hops. It is `11025 32 8` on all 81 tracks, so a hop is 2.9 ms. The parse consumes the buffer exactly on 81 of 81 tracks and every band's total span lands within 1% of the track duration. `src/rhythm.ts` decodes it with `DecompressionStream`; if that is missing or the string is malformed, `hits` is empty.

It is not drum transcription. Events per band per second are 2.7 / 2.9 / 3.2 (p5/p50/p95) across 66 to 200 BPM and every genre in the set. The busiest band exceeds the sparsest by only 1.07 / 1.15 / 1.27. Each band emits at a bounded rate whatever the music does, so no single band is a hit detector.

What is usable is where the bands agree. `clustersOf` groups onsets within 25 ms of the first one in a cluster and calls it a hit when at least 3 of the 8 bands fired. `Hit.bands` (3 to 8) is its breadth. Measured against the beat grid, +-50 ms, 81 tracks, median:

| detector | precision | beat recall | hits per second |
|---|---|---|---|
| segment rule (sharp, prominent segment) | 28% | 51% | 3.5 |
| 3 or more bands agree | 44% | 63% | 3.1 |
| 4 or more bands agree | 49% | 43% | 1.8 |

Precision is measured against beats, the only annotation the analysis has, so a real off-beat drum counts against it. Across 316k hits, a 3-band hit lands on a beat 34% of the time and an 8-band hit 64%, rising with the count.

For comparison, recall of the beat grid by one source (p5/p50/p95): segment starts 29 / 53 / 75%, rhythm band 0 39 / 64 / 87%, bands 1 to 7 32-35 / 46-57 / 59-83%. On downbeats, band 0 recalls 69% of bar lines against band 7's 52%.

Read by the live code: `Hit.bands` of the hit nearest a segment start, as `breadth` in `createNextSound` (Drift). 8 of 89 dumps carry no `rhythmstring`.

### 2.6 What the analysis will not tell us

- Register (how high a sound is). `pitches` has no octave. The rhythm bands cannot give it either: across 26 468 hits, 67% touch the lowest band, 77% the highest and 48% both, because broadband onsets are what the detector selects. Band centroid against the segment's `timbre[1]` correlates at r = 0.07. `timbre[1]` (dull against ringing) is the nearest thing, used by rank.
- Where the drums are. Every band's onset rate is pinned (on one track the low band runs at 8.5 events a second from the first bar to the last).

## 3. What the code derives

### 3.1 `TrackAudioData` (audio-data.ts)

| field | what it is |
|---|---|
| `beats`, `segments`, `bars`, `tatums`, `sections` | the analysis arrays, verbatim; `bars`, `tatums` and `sections` are `[]` when absent |
| `tempo` | `track.tempo` |
| `loudnessCurve` | see below |
| `hitScale` | see below |
| `timbreSorted` | every segment's `timbre[1]`, sorted. `rankOf(sorted, value)` gives a 0..1 rank, or 0.5 when there are fewer than 16 values |
| `moments` | see below |
| `hits` | decoded `rhythmstring` hits (section 2.5) |
| `trackInfo` | `track`, verbatim |

`loudnessCurve` and `normaliseCurve`. Points are taken at each segment's start (`loudness_start`) and at its peak (`loudness_max`, at `loudness_max_time`), converted from dB to amplitude, plus the last segment's `loudness_end`. The curve is then stretched so the track's 5th and 95th percentiles land on 0.06 and 0.62 (`ENERGY_QUIET`, `ENERGY_LOUD`) and blended 70/30 with the raw value. A track mastered at -13 dB would sit at 0.22 for its whole length. Percentiles rather than min and max, because one silent outro would otherwise define the scale. Only 70%, because full normalisation makes a gentle song move like a loud one. `normaliseCurve` is exported so the harnesses apply the same stretch. Trust: high.

`hitScale`. The track's 98th percentile of segment amplitude (`10^(loudness_max/20)`), at least 0.02, 0.56 when there are fewer than 8 segments. Everything that asks "was that a big hit" divides by it. It replaced `min(1, amplitude * 1.8)`: measured across the dumps, 0% to 97% of a track's segments (median track about 57%) sit above that clamp, so in a chorus every hit compared equal and a "beat the loudest recent hit" test fired every 1.3 s on the busiest track. With the per-track scale the same test gave 1 to 4 a minute.

`moments` (`findMoments` in `track-structure.ts`). The few places where this track's own loudness takes its largest sustained step up. It does not claim these are choruses. Three earlier detectors read loudness and claimed that, and scored 2 accurate hits out of 11 firings across six tracks.

- Candidate score every 0.25 s from 8 s on: mean of the curve over 0.4..3 s after, against 0.4..4 s before, divided by `max(before, median * 0.4)`. The floor stops the track's own start from winning.
- Greedy, largest first, at least 14 s apart, at most 5, each at least 40% of the track's best and at least 0.22 (about 1.7 dB).
- Each pick is moved to the steepest point of the one-second-mean curve within 1 s before to 3 s after it, because the scoring window peaks up to 3 s early. Moving it onto the section boundary makes the drop land late. It then snaps onto a bar line within 0.5 s.
- `size` is how much of the rise is still there ten seconds later: `(mean(t+4..t+10) - before) / max(before, median * 0.4)`, clamped 0..1. Against a fixed reference: a hold of 1 (the music settles at twice what it rose from) is full size. Over 84 dumps the biggest sustained rise a track has spans 0.23 to 3.65 of the level it came from (p05 0.39, median 1.01, p95 2.55). Dividing by the track's own best would give every track one full-size moment however flat it was. A momentary spike and a step score the same under the `rise` score alone; the hold separates them.
- `leadSeconds`, `dip`, `build` (`describeLeadIn`; no preset reads `build` now): what the music does on the way in, from a one-second mean of the curve (the raw curve is a per-segment sawtooth, see below). Baseline is taken 9 to 16 s before. The run-in is the stretch before the moment that is more than 14% off baseline, and only a return to baseline lasting one beat of this track ends it. `leadSeconds` is clamped to 1.2..8 s. Over 345 moments, allowing that one-beat gap moved the share at the 1.2 s clamp from 49% to 30% and the median lead from 1.25 s to 2.75 s. Moments at exactly 8 s mean "longer than the window", not a measurement.

Does it survive a modern master? Measured over 81 tracks by how hot the master is:

| master | tracks | moments (p5/p50/p95) | tracks with none | segment range within the track | section spread |
|---|---|---|---|---|---|
| louder than -4 dB | 11 | 1 / 4 / 5 | 0 | 10.9 dB | 23.1 dB |
| -4 to -6 dB | 36 | 2 / 4 / 5 | 0 | 13.6 dB | 11.4 dB |
| -6 to -8 dB | 24 | 2 / 4 / 5 | 0 | 15.1 dB | 12.1 dB |
| quieter than -8 dB | 10 | 1 / 5 / 5 | 0 | 14.7 dB | 15.1 dB |
| all | 81 | 2 / 4 / 5 | 0 | 13.8 dB | 12.6 dB |

Compression flattens the average level, not the moment-to-moment range. Where drops were marked by ear, the detector landed within a second on the tracks checked; two tracks that start quiet and kick in put a moment in their first seconds.

Removed in 0.3.0 after being switched off: a chorus-by-repetition detector. It built per-bar chroma and timbre vectors, mean-centred them, found boundaries with a checkerboard novelty kernel (Foote), grouped the blocks and picked the group that repeats while loud and bright. Judged by ear it was wrong more often than right, and on one track a chorus felt right where it stayed silent. One track's labels were the times the visualiser fired, so its 3/3 was the detector scored against its own output. The code is in v0.2.0 (`git show v0.2.0:src/track-structure.ts`).

### 3.2 Colour

The cover's colours come from `Spicetify.colorExtractor` (dark, vibrant and light; `extractColorPreset` is the fallback) and are shaped into palettes in `colours.ts` (see ARCHITECTURE.md, Colours). The frame loop (`ui/use-frame-loop.ts`) eases the displayed colours towards a new cover's with a 0.6 s time constant.

`keyHueAt` (effects.ts) leans the hue off the album's by how far the playing section's `key` sits from the track's home key (`trackInfo.key`) on the circle of fifths. The home key gives no lean; the far side of the circle gives `HUE_SWING`, which is `HUE_REACH` = 30 degrees (0.083 turns; it was 0.26, 94 degrees, until 0.3.0); the square root makes the nearest key already visible. `createKeyHue` moves at most `HUE_RATE` = 0.05 turns per second. Measured over 105 tracks, a section's key differs from the previous one 1.6 times a minute and half of playing time is away from the home key. Following the chroma's tonal centre instead wobbled +-15 degrees every second on every track measured. Per-section key is a low-confidence estimate (section 2.3).

### 3.3 Signals from the Conductor that the live code reads

`createConductor()` is called once per preset instance and returns a `Conductor` each frame. The two live presets read only the signals below. Easing is `value += (target - value) * Math.min(1, rate * dt)` with `rate` per second, so it does not depend on frame rate; `↑a ↓b` marks different attack and release rates.

| signal | source | easing | meaning |
|---|---|---|---|
| `dt` | `progressSec` difference | none | seconds since the last frame, clamped to 0.05 so a stall cannot fast-forward the scene. 0 on the first frame and after a seek backwards |
| `scale` | `min(width, height)` | none | the unit for sizes that must hold at any resolution |
| `energy` | `sampleCurve(loudnessCurve, t)` | none | normalised loudness now. It is not a level: it is an attack-decay ramp per segment and reverses direction 3.8 times a second (over 89 dumps), and any half second of it spans 2.0x. Use for brightness and width, never for a speed. With no analysis: a sine while playing, 0.5 paused. See "between tracks" below |
| `loudness` | mean of seven samples spread over +-0.75 beat (1.5 beats wide) centred on the playhead | none, no lag by construction | the loudness without the sawtooth. Anything that sets a speed reads this. A follower was late by its own time constant (the field accelerated up to 2.9 s after a drop); the analysis is a timeline, so a centred window removes the delay. Verse-to-chorus speed measures 1.68x with either |
| `impact` | `moments` | a function of `timeToImpact`, not a filter | the release at a moment: rises over 0.7 s into the moment so its peak lands on it (smoothstep, times size), falls over 1.8 s after (power 1.6). The moment is evaluated 0.12 s ahead of the clock. Scaled by the moment's size |
| `timeToImpact` | `moments` | none | seconds to the next moment within 25 s, else `null`. The only signal that looks forward |
| `anticipation` | `timeToImpact` | ↑3 ↓9 | 0..1, rising over the moment's own `leadSeconds` (power 1.6, times size), released at it |
| `windup` | `timeToImpact`, `leadSeconds`, size | none | the brace before the moment: spans `leadSeconds` clamped 1.2..7 s, power 1.25, peaks at the moment, then holds and releases over 1.9 s. Gated by how loud the approach has been (see below) |
| `runInDip` | the next moment's `dip` | 4 | how far the music thins out before the moment, 0..1 |
| `harmonicShift` | cosine distance between this and the previous segment's `pitches`, times 2.5, clamped 1 | ↑25 ↓7 | moves when the harmony's spectrum changes. Updates on segment change |
| `brightness` | `max(0, timbre[1] / 100)`, clamped | 0.8 | spectral brightness of the current segment, 0..1 |
| `attackSharpness` | `1 - loudness_max_time / 0.25`, clamped | 6 | how abrupt the current segment is. Updates on segment change. Texture only (section 2.1) |

`windup` is gated because a wind-up that reads only the destination comes out inverted. Over 311 run-ins the correlation between the energy during a run-in and the speed it reached was r = -0.30: a moment is big because the stretch before it was quiet, so size correlates with silence and, when it set a speed, the field sprinted through quiet passages. It no longer sets a speed; it holds the brace (the picture dims and the flow narrows). The gate is `min(1, approachEnergy / max(0.08, curveMedian * 0.75))`, where `approachEnergy` is a 2 s follower of `energy` and `curveMedian` the track's median curve value, so "quiet" is relative to the track.

`harmonicShift` is not "the tonal centre moved". In the second after a spike the tonal centre moves no further than in a quiet second before it (0.154 of the ring against 0.178 on one track, 0.102 against 0.121 on another). It says the spectrum of the harmony changed, which a change of level or timbral balance moves as readily as a chord. The angle of a weak resultant over chroma is noise (it covered the entire ring over one song and moved a quarter of it in a second), so no tonal-centre angle is used.

Between tracks (`GAP_REST` 0.12, `GAP_HOLD` 3 s, `JOIN_SECONDS` 1.5). While the next analysis loads, `energy` and `loudness` breathe out towards 0.12 instead of following the fallback sine. Only a track still without analysis after 3 s gets the sine. When an analysis arrives, the level comes round to the new track's own over 1.5 s (smoothstep) from wherever it was. Assigned directly, the level falls from 0.56 to 0.10 in one frame, dividing every speed in the picture by four. `npm run check` asserts the level neither climbs while waiting nor steps by 0.02 or more in one frame.

### 3.4 NextSound (next-sound.ts)

`createNextSound()` answers for the segment about to start. It exists because an event is read at its peak, so anything that takes time to reach full strength has to start before the sound. Drift uses it.

| field | meaning |
|---|---|
| `fired` | true on exactly one frame per sound, `lead` seconds before its segment starts |
| `lead` | `min(0.4, rise * 0.9)` |
| `amp` | `10^(loudness_max/20) / hitScale`, unclamped. With no segments, the `fallbackAmp` argument |
| `ringing` | `rankOf(timbreSorted, timbre[1])`, 0.5 with no data. Dull to ringing within this track |
| `rise` | `loudness_max_time * 2.4 + 0.04`, clamped 0.05..0.55 s |
| `decay` | `3.4 / max(3, fall)`, clamped to 0.4..1.6 beats, where `fall` is the dB drop from this segment's peak to the next segment's start (8 when there is no next) |
| `sharp` | `1 - min(1, loudness_max_time / 0.12)` |
| `breadth` | `(bands - 3) / 5` of the rhythm hit within 0.07 s of the segment start, else 0 |
| `standout` | `amp` above 1.1 times a running average of recent sounds (updated by 0.2 of the difference at each sound, and judged before the sound joins it) |

`standout` against a decaying peak (4.6 s half-life) would be cleared by 71 to 92% of hits. Against a running average of recent hits 2 to 34% do, and a compressed track getting almost none is correct.

### 3.5 Removed in 0.3.0

Up to 0.2.0 the conductor also computed `momentum`, `glow`, `pop`, `beatStrength`, `beatHit`, `segment`, `strike`, `lookAhead`, `sectionIntensity`, `trend` and `level`, which neither live preset read. They are gone with their helpers; `git show v0.2.0:src/presets/flowfield-common.ts` has them, each described on the `Conductor` type. `dev.ts` writes every numeric field of `lastConducted` into the dev-build marker.

`strike` is a segment start that has a rhythm hit within 60 ms, with strength from the band count (0.6 for 3 bands up to 1 for 8). Without a `rhythmstring` it falls back to a sharp, prominent segment. Fired directly off the onsets rather than on the segment clock it is a better detector and a worse picture: the light landed on the beat 24% of the time against 41%, because everything else runs on the segment clock and two event streams smear each other.

## 4. Tried and rejected

| attempt | what happened |
|---|---|
| `loudness_max_time` as a percussion isolator | the segment describes the mix, not the drum. Three attempts |
| absolute dB thresholds | failed three times. A flat 2.5 dB never fired on five real tracks; scaling to the track's dB range fired less, because one -20 dB fade-out set the range |
| chorus from loudness (3 versions) | 2 accurate hits in 11 firings over six tracks. A track that is loud throughout has no loudness event at its chorus |
| chorus from repetition (chroma + timbre) | see section 3.1. Removed in 0.3.0 |
| `min(1, amplitude * 1.8)` | a ceiling inside a comparison, see `hitScale` |
| a hand-made online "arrival" detector driving brightness and speed | fired 8 to 80 times a track, twice inside one second. Replaced by `moments` |
| validating a detector on synthetic audio | scored 3/3 on data built to match its own assumptions, then found a whole song to be one chorus |
| scoring a detector against labels it produced | one track's ear labels were the times the visualiser had fired |
| section boundaries as moments | they are a timbral segmentation. Ranking sections fired on the wrong moments |
| the chroma's tonal centre as a colour driver | wobbled +-15 degrees a second on every track measured |
| `loudness` as an exponential follower | late by its own time constant. Replaced by the centred window |
| speeds that follow a sound (a mark thrown on its hit, runners thrown harder, the field winding up before a drop, strokes hurrying in a mark's wake) | the field moved on every sound. Measured on 24 dumps, a stroke in a mark's wake went up to 2.2x its speed, changing at up to 1582% a second. Speed now follows the ten-second loudness envelope: the fastest change of a stroke's speed is 10% a second |
| the section's key leaning the hue by 94 degrees, the line and marks turned a fixed 50 degrees, Drift's shimmer rotating R, G and B | a red-and-black cover gave Ridgeline green lines, a teal one gave Drift purple marks. All hue shifts now share one cap of 30 degrees from the cover's colour, see ARCHITECTURE.md, Colours |
| a fixed 3.5 s floor under the wind-up span | overrode the measured run-in. Half of all moments measure shorter lead-ins |

## 5. Not used yet

- `timbre[2]` and `timbre[3]`: wide and nearly independent of loudness.
- `tatums`, `start_of_fade_out`, track-level `time_signature` (median confidence 1.00; the bar logic assumes four to a bar), `beat.confidence`, `synchstring`, the `audio-features` `valence` and `energy`.
- Segment `confidence` is read only by Ridgeline's row weights. Bar confidence is read only by `beatStrength`, which neither live preset uses.
