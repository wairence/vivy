# Measurements

Every number this project can read, what it means, and **how much of it is true**.

Two layers: what Spotify's analysis hands us, and what we compute from it. `SIGNALS.md`
documents the second layer as an API — what to call and what shape it comes out in. This
documents both layers as *evidence*: where each number comes from, what it does and does not
know, and what it would be reasonable to build on it.

**Every trust claim below is measured**, on the 81 full dumps in `analysis-dumps/` — 67 094
segments, 35 176 beats, masters from −1.9 dB to −19.8 dB and tempi from 66 to 200 BPM, chart pop
included on purpose — unless it names a smaller base. A few claims still rest on the 19
older, thinner dumps (14 930 segments, 2 293 bars) and say so. Where a field has never been
measured,
it says so in those words rather than repeating what the documentation claims. That
distinction is the whole point of this file: this project has been wrong four times by
believing an instrument instead of checking it, and twice by believing Spotify's
documentation instead of the endpoint.

> **Widening the base corrected two of these entries.** On the first three full dumps
> `tempo_confidence` read 0.17–0.34 and `time_signature_confidence` looked worthless; across 81
> tracks their medians are **0.63** and **1.00**. Three tracks answer "does this exist and does
> it vary" and nothing more. To collect: run `npm run live` for its server, keep the visualizer
> tab open, play tracks — each one that lands announces itself.

---

## 1. What Spotify gives us

One request, `Spicetify.getAudioData(uri)` → the internal
`audio-attributes/v1/audio-analysis/{id}` endpoint. Everything below arrives in that one
response, for the whole track, before a note plays. **That is the single most important fact
about this data source**: it is not a live feed. Anything can be measured over the entire
track, offline, at load — including the future. Every mechanic that needs to act *before* a
moment (the star's launch, the brace, the release) exists because of this.

### 1.1 `segments[]` — the backbone

A segment is a stretch the analyser considers acoustically uniform. It is not a note and not
a beat: it is a division of the audio by change, so a busy passage produces many and a
sustained chord produces few.

**Rate:** 2.3–4.8 per second depending on the track. Duration p5/p50/p95 = **0.10 / 0.23 /
0.59 s**. This is the resolution ceiling for everything per-moment: nothing read from
segments can respond faster than about a quarter of a second.

#### `loudness_max` (dB)

*What:* the peak loudness inside the segment, in dBFS.

*Trust:* **high, and the only field with no caveat.** p5/p50/p95 across all segments
= −26.7 / −6.1 / −0.2 dB. But the *scale* is mastering, not music: on the 19 tracks the share
of segments above −5 dB ranges from **0 % to 97 %**. A number that means "loud" on one track
means "silence between phrases" on another.

*How we use it:* everywhere. `energy`, the loudness curve, `hitScale`, the hit power behind
the star and the middle rank.

*How to use it:* **always relative to the track's own distribution, never against a
constant.** `hitScale` (§2.2) is the 98th percentile of segment amplitude; `normaliseCurve`
(§2.1) stretches the 5th–95th. Both exist because absolute thresholds failed three separate
times here. See DESIGN-RULES §3c for what happens when a clamp lands inside a comparison.

#### `loudness_max_time` (seconds into the segment)

*What:* how long the segment took to reach its peak. The obvious reading is "attack time" —
small means a transient, large means a swell.

*Trust:* **low for what it is usually wanted for.** p50 = 0.043 s, p95 = 0.161 s. Measured:
the share of segments that peak within 60 ms is 49–92 % of *all* segments, and 28–100 % among
the *loudest tenth* — and the direction is not even consistent. On `Harmonious` loud segments
are markedly **less** sharp than average (28 % vs 58 %); on `ロマンサー` slightly more (100 % vs
92 %). There is no stable relationship between "loud" and "sharp".

The reason is structural, not statistical: a segment of a dense mix contains the drum
*together with everything else*, so its attack time describes the mix. **Percussion cannot be
isolated from this data.** Three attempts died on that.

*How we use it:* `attackSharpness`, as a texture and width modulator, and as one gate among
several on the star. Never alone, never as "is this a drum".

*How to use it:* as a *character* input — how abrupt this moment is — not as a classifier.

#### `loudness_start`, `loudness_end`

*What:* loudness at the segment's edges.

*Trust:* **present, and the discontinuity idea does not survive contact with the numbers.** The
plan was to read `loudness_end[i]` against `loudness_start[i+1]` as a cut detector. Measured,
that gap has a median of **6 to 30 dB** depending on the track: a large step
across a boundary is the *normal* case, not the exception, because a segment ends where the
previous sound has decayed and the next one begins at its own onset. `loudness_start` correlates
with `loudness_max` at only 0.61–0.77, so it is not simply loudness again either.

*How to use it:* if a cut detector is wanted, the step has to be ranked against that track's own
distribution of steps, like everything else here. Absolute is meaningless when the median is
30 dB on one track and 6 dB on another.

#### `pitches[12]` — chroma

*What:* energy per pitch class (C, C♯, D …) within the segment.

*Trust:* **normalised, and much flatter than it looks.** Measured: the maximum is **exactly
1.000 in all 14 930 segments** — so this is a *shape*, and carries no magnitude at all.
Mixing it with loudness is a mistake the type system will not catch. The strongest class holds
a median of only **23 %** of the total (a flat 12-band distribution would be 8.3 %), so it is
a smeared harmonic profile, not a pitch detector. Consecutive segments have a median cosine
similarity of **0.79** — it barely moves frame to frame.

**And at bar scale, raw, it is nearly useless.** Cosine between every pair of bars at least
four apart: median **0.77–0.97** per track, and on several tracks the whole p5–p95 band is
0.13 wide. Everything looks like everything. That is exactly why the chorus detector once
reported that a whole song was one chorus.

**Mean-centring fixes it, and is mandatory.** Subtract the track's own average chroma and the
same pairwise similarity goes to a median of ≈ **−0.04** with a spread of **1.08–1.46** — the
full range restored. The information was there; the track's key was drowning it.

*How we use it:* `harmonicShift` (rate of change of a continuous tonal centre), the melody
layer's lean, and the chroma preset's 12 zones.

*How to use it:* comparison between distant points in a track — repetition, return, the
chorus question — **always mean-centred**. Never as a magnitude, never as "which note is
playing".

#### `timbre[12]`

*What:* 12 coefficients of a basis over the spectral surface. Only the first few have a
plain-language meaning: [0] ≈ loudness, [1] ≈ brightness, [2] ≈ flatness of attack.

*Trust:* **[0] is loudness again; [1] is the widest; [2] and [3] are free of loudness
entirely.** All twelve measured over 67 094 segments:

| coefficient | p5 → p95 | spread | r with `loudness_max` |
|---|---|---|---|
| [0] | 37 → 57 | 20 | **0.95** — redundant, do not use |
| [1] | −75 → 116 | **191** | 0.38 |
| [2] | −76 → 86 | **162** | **0.08** |
| [3] | −65 → 61 | 126 | **0.05** |
| [4] | −21 → 76 | 97 | −0.10 |
| [5] | −67 → 28 | 95 | 0.07 |
| [6] | −44 → 42 | 86 | 0.08 |
| [7] | −39 → 34 | 73 | 0.05 |
| [8] | −34 → 25 | 59 | 0.03 |
| [9] | −27 → 30 | 57 | 0.06 |
| [10] | −40 → 16 | 56 | −0.07 |
| [11] | −23 → 25 | 48 | −0.09 |

[1] has by far the widest range and only middling correlation with loudness. **[2] is the one
nobody would have guessed**: a 162-wide range — second only to [1] — at a correlation with
loudness of 0.06. It is a large, completely loudness-independent axis that nothing here reads.
[3] is the same idea with two thirds of the range. Everything from [5] up is narrower and
correlates with nothing; treat those as noise until someone shows otherwise.

*How we use it:* [1] only, as spectral brightness, in the chorus detector's frames.

*How to use it:* **[1] and [2] are the best unused fields in the analysis.** A chorus on a
modern master is often no louder than the verse but is nearly always brighter — more cymbals,
more top end — and [1] measures that. [2] is nearly as wide and independent of loudness, which
makes it the natural input for anything that must not brighten when the music gets loud.

#### `confidence`

*Trust:* **it exists and it uses its whole range.** Measured over 67 094 segments: p5/p50/p95
= **0.07 / 0.54 / 1.00**. The analyser genuinely disagrees with itself about how well-defined a
segment is, and the spread is as wide as a confidence can be.

*How to use it:* as a weight, not a filter — a low-confidence segment is a blurry one, not a
wrong one. It is the obvious missing term in `hitScale` and in the star's gate: a hit the
analyser is unsure about should not become the rarest event on screen.

---

### 1.2 The grids — `beats[]`, `bars[]`, `tatums[]`

Three nested pulse grids, each `{ start, duration, confidence }`. Tatums subdivide beats,
beats group into bars.

#### `bars[]`

*What:* which beat starts a bar — the metrical grid.

*Trust:* **the grid is excellent; the confidence field is not the way to judge it.** Measured:
per-track bar duration varies by only **0–4 %** around that track's median (median bar 1.68 s),
so as a clock it is very steady. Meanwhile `confidence` has p5/p50/p95 = **0.12 / 0.47 / 0.80**
— roughly a coin flip, on grids that are demonstrably regular. **Read the geometry, not the
self-report.**

One trap, measured: a bar start coincides with a segment start only **28–68 %** of the time
(median ≈ 45 %). The grids are independent. Never assume alignment; always search for the
nearest.

*How we use it:* `nearestBarStart` decides whether a coming hit is a downbeat — the star's
strongest gate. The chorus detector's frames are per-bar. `findRises` snaps a moment onto the
nearest bar line.

*How to use it:* it is the project's most reliable structural signal after raw loudness. Any
event that should feel deliberate rather than reactive belongs on a bar line.

**And bars are a strict subset of beats:** **100 %** of bar starts land within 30 ms of a beat,
on all 81 tracks without exception. So the two grids are consistent with each other even
though neither aligns with segments.

#### `beats[]`

*Trust:* **the grid is right, the confidence is middling and worth reading, and it does not
line up with segments.** Measured over 81 tracks: beats per minute lands within a few per cent of the
reported tempo almost everywhere (`lilac slumber` is the exception at 146 against a reported
168 — a half-time or triplet reading). Confidence over 35 176 beats: p5/p50/p95 = **0.12 /
0.44 / 0.81**. A beat start coincides with a segment start
only **7–47 %** of the time.

**The confidence predicts whether the grid can be trusted, and this is measurable.** Correlation
between a track's median beat confidence and how strongly the `rhythmstring` events cluster on
its beats is **r = 0.50** over 81 tracks. The four tracks whose events look random against their
own beat grid — `asphyxia` 0.15, `神様` 0.29, `鏡面の波` 0.32, `一緒なら` 0.37 — are the four with
the least confident grids. It is not the events that are wrong there.

In the live client `beats.length === 0` triggers a warning and has fired on real tracks, so
absence is a real case.

*How we use it:* `beatStrength`, `pop`, the beat grid the drum layer's ignition rides on.

*How to use it:* read `confidence` before trusting the grid on a given track. It is the one
number here that would have flagged `asphyxia` in advance.

#### `tatums[]`

*Trust:* **they exist, and they are exactly two per beat — on all 81 tracks, without a single
exception.** The ratio is 2.00 at 66 BPM and at 200 BPM, in every genre in the set. A tatum is
a half-beat and nothing more: there is no extra rhythmic information in this field, only extra
resolution.

*How to use it:* as a half-beat grid, for anything that should sit between beats — an offbeat
accent, a swing. It will not describe a triplet or a roll.

---

### 1.3 `sections[]`

`{ start, duration, confidence, loudness, tempo, key, mode, time_signature }`.

*What:* Spotify's own segmentation of the track into large blocks, each with its own summary.

*Trust:* **the loudness ranking is real; the per-section key and metre are not.** Measured over
25 tracks, 8–11 sections each:

- **`loudness` spans a genuine range within a track** — p5/p50/p95 of that spread is
  **3.5 / 12.6 / 35.7 dB**. Twelve decibels between a track's own sections is plenty to rank.
- **`confidence` uses its whole range**: p5/p50/p95 = 0.10 / 0.59 / 1.00.
- **`time_signature` disagrees with itself on 27 of 81 tracks** — sections marked 3 and 5 inside
  a track labelled 4/4 — and a track claims a **median of 4 distinct keys**, up to 8. These are
  not modulations; they are a low-confidence estimator changing its mind every block.
- **`tempo` is stable and agrees with the track** (±1 BPM across every section measured).

These are a *timbral* segmentation, not a musical map: a boundary is not a chorus, and treating
it as one produced a visible step in speed and brightness where the music had nothing. The
response was slowed from 0.6 s to ~7 s for exactly that reason (`sectionIntensity`,
`flowfield-common.ts`).

*How we use it:* `sectionIntensity` — each section's loudness as its **rank** among this
track's own sections, 0..1. Rank rather than dB, because a modern master compresses a chorus
to a decibel over a verse while an older one spans ten. This is what gives a chorus its weight
in the layers preset, more than any brightness term.

*How to use it:* as a slow budget — how many particles, how much light, how much size this
part of the song is allowed. Never as a trigger. Per-section `key`, `mode` and `time_signature`
are measurably unreliable and should stay unread; per-section `tempo` is solid if a
tempo-following mechanic ever needs it.

---

### 1.4 `track` — the summary

*What:* **26 fields, not the two we had declared.** The endpoint returns `duration`,
`loudness`, `tempo`, `time_signature`, `key`, `mode`, a confidence for each of those four,
`end_of_fade_in`, `start_of_fade_out`, `num_samples`, `analysis_sample_rate` (22050),
`analysis_channels` (1), `offset_seconds`, `window_seconds`, an empty `sample_md5`, four
version numbers, and **four large encoded strings** — see §1.5.

*Trust:* **the four confidences are not equal, and the two I would have guessed were worthless
are the two that are fine.** Across 25 tracks (min / median / max):

| field | min | median | max |
|---|---|---|---|
| `tempo_confidence` | 0.00 | **0.63** | 1.00 |
| `time_signature_confidence` | 0.03 | **1.00** | 1.00 |
| `key_confidence` | 0.00 | 0.48 | 0.98 |
| `mode_confidence` | 0.15 | 0.51 | 0.80 |

Metre is known outright on most tracks and tempo usually is; key and mode sit at roughly a coin
flip and mode never exceeds 0.80. **The first three full dumps said the opposite** — tempo
confidence 0.17–0.34 and a time signature confidence of 0.028 — which is what three tracks buys
you.

*`start_of_fade_out` works and is free:* **77 of 81 tracks report a real fade**, median
**6.8 s** long (p5/p95 = 2.7 / 14.4 s). The other four set it equal to the duration, which is
how it says "no fade". That is "the track is ending", exactly, with no inference — currently
unknowable to us.

*How we use it:* `tempo` only.

*How to use it:* `start_of_fade_out` for an outro — it fires on 77 of 81 tracks and costs
nothing. **Track-level** `time_signature` (median confidence 1.00) to stop the bar logic quietly
assuming 4/4; the per-section values are noise. `loudness` as a second opinion on `hitScale`.
`key`/`mode` as a per-track palette, and only when their own confidence allows.

### 1.5 The undocumented strings — and `rhythmstring`

Four fields in `track` are long encoded blobs: `codestring`, `echoprintstring`, `synchstring`,
`rhythmstring`. Nothing in this project had ever looked at them.

**They are zlib data in URL-safe base64.** Every one begins `eJx`, which is the base64 of a
zlib header. Decoding is two lines:

```js
const raw = Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const text = require("zlib").inflateSync(raw).toString("utf8"); // whitespace-separated integers
```

`codestring` and `echoprintstring` are acoustic fingerprints — for matching a recording against
a database, of no use here, and 4 k–24 k characters each. **They are now stripped from the dump.**
`synchstring` is timing/synchronisation data, not yet examined.

#### `rhythmstring` — eight bands, and the closest thing to a kick detector we have

> **In use since 2026-08-29.** `src/rhythm.ts` decodes it at track load and clusters the eight
> bands; a cluster that at least three bands contribute to within 25 ms is a hit. `Conductor.strike`
> is now a segment start *gated* by one of those clusters within 60 ms — 48% precision and 44% beat
> recall against the old segment rule's 28% and 51%. Firing off the onsets *directly* was tried and
> measurably reversed: better detector, worse picture, because everything else in the visual runs on
> the segment clock and two clocks smear each other. The bands say which segments are hits.

*Layout,* worked out from the data and verified: `sampleRate hopSize numBands`, then for each
band a count followed by that many gaps measured in hops. Measured: **`11025 32 8` on all 81
tracks**, so a hop is 32/11025 = **2.9 ms**. Time of the *n*-th event = cumulative gap × hop /
sampleRate. Two independent checks that the layout is right: the parse consumes the buffer
**exactly, 81 times out of 81**, and every band's total span lands within 1 % of the track
duration.

Decoding is two lines — the same for all four encoded strings:

```js
const raw = Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const text = require("zlib").inflateSync(raw).toString("utf8"); // whitespace-separated integers
```

##### It is not drum transcription. That question is now closed.

The three-track sample raised a suspicion; 81 tracks settle it. **Events per band per second is
2.7 / 2.9 / 3.2** (p5/p50/p95) — unchanged from the 25-track figure, across 66 BPM to 200 BPM
and every genre in the set. And the busiest band exceeds the sparsest by only
**1.07 / 1.15 / 1.27**. A hi-hat pattern cannot be
within 12 % of a kick pattern on every track ever recorded, and an onset rate cannot ignore
tempo. Whatever these are, they are emitted at a bounded rate per band — note that ~2.9/s is
also roughly the segment rate. Per-band change points, not hits.

##### But band 0 is the best beat-locked event stream in the whole response.

Measured as **recall of the beat grid** — what share of beats have an event within 50 ms —
compared against the segment starts everything currently runs on:

| source | p5 / p50 / p95 |
|---|---|
| segment starts (what we use now) | 29 / **53** / 75 % |
| **rhythm band 0** | 39 / **64** / 87 % |
| rhythm bands 1–7 | 32–35 / **46–57** / 59–83 % |

Band 0 beats the segment starts by eleven points at the median and leads every other band. On
**downbeats** specifically the split is starker: band 0 recalls **69 %** of bar lines against
band 7's **52 %**. (On the narrower 25-track set band 7 managed only 43 % — the gap closes on
chart pop, where the top of the spectrum is busy on every beat.) That is a kick against a hi-hat, and it is the low-frequency
event stream `segments` cannot give us, because a segment is full-band by construction.

Supporting evidence that these are musical events and not a clock: the phase histogram over the
beat deviates from flat by 9–39 % (p5–p95, median 25 %), and **that deviation correlates with
the track's own beat confidence at r = 0.50**. Where the events look random against the grid, it is
the grid that is unconfident — the four flattest tracks are the four with the least confident
beats.

##### Why this matters

The standing conclusion here is "**percussion cannot be isolated from this data**", reached
honestly and three times over — from `segments`, whose attack time describes the whole mix.
That conclusion stands *for segments*. Band 0 of `rhythmstring` is a different field, it is
frequency-limited, and it locks to the beat better than anything we currently read.

*Not built on yet.* `npm run rhythm` decodes and reports it. Before it replaces `strike`, the
thing to check is precision, not recall: this measures how many beats have an event, not how
many events are on a beat, and at 2.9 events a second a band could score well by simply being
dense.

### 1.6 The fallback: `audio-features`

When `audio-analysis` 404s — and it does, on real tracks — its sibling endpoint still answers
with one summary row: tempo, loudness, key, mode, energy, danceability, valence.

*Trust:* **it is a description of the track, not of the moment.** Everything derived from it
is a constant for the whole song.

*How we use it:* `trackDataFromFeatures` builds a synthetic beat grid from the measured tempo
and a flat loudness curve. Motion, no structure.

*How to use it:* it is also the only place `valence` and `energy` as *musical character* are
available. Nothing reads them. A palette or a resting temperament chosen per track is the
obvious use.

---

## 2. What we compute

### 2.1 `loudnessCurve` + `normaliseCurve`

Per-segment amplitude, resampled, then stretched onto the track's own **5th and 95th
percentiles** and blended 70/30 with the raw value.

*Why:* a track mastered at −13 dB used to sit at 0.22 for its whole length and render as a
permanent interlude. Loudness is a property of the mastering. Percentiles rather than min/max
because one silent outro would otherwise define the scale.

*Why only 70 %:* full normalisation gives every track the same dynamic range, which makes a
gentle song move like a loud one. The remaining 30 % keeps a quiet track quieter.

*Trust:* **high.** This is the most reliable derived measurement we have.

### 2.2 `hitScale`

The track's own **98th percentile** of segment amplitude. Every "was that a big hit?" divides
by it.

*Why the 98th and not the max:* one clipped transient must not define the scale for the whole
track.

*Trust:* **high, and it fixed a silent failure.** The previous form was `min(1, amplitude ×
1.8)` — and measured across these dumps, **0 % to 97 %** of a track's segments sit above that
clamp (median track ≈ 57 %). Through a chorus, every hit compared exactly equal, so the star's
"beat the loudest of the last few seconds" test was asking `1 > 1` all song. It fired every
1.3 s on the busiest track. Same fix took it to 1–4 a minute.

### 2.3 `sectionIntensity`

See §1.3. Rank, not decibels.

### 2.4 `moments` — `findRises`

The handful of places where **this track's own loudness takes its largest sustained step up**:
mean of the 3 s after against the 4 s before, proportional, greedy peaks 14 s apart, capped at
five per track.

*What it does NOT claim:* that these are choruses. Three earlier versions asserted that from
loudness and were wrong about half the time. This asserts only what it measured.

*Trust:* **bounded by construction, which is the point.** 1–5 per track across all 19 dumps,
every firing large. Where the listener left labels by ear it lands on them: asphyxia 0:15 vs
0:14, daidai naru 0:44 / 1:29 vs 0:43 / 1:28, String Theocracy 0:38, the perfect pair 0:32,
一緒なら 1:17, Charlie's Inferno 1:07 vs a reported 1:06. Two tracks still put a moment at
0:08–0:12 — a track that genuinely starts quiet and kicks in.

*How we use it:* `impact`, `anticipation`, `windup`, `runInDip`, `runInBuild` — the entire
brace-and-release mechanic.

*And how big one is — fixed 2026-09-16.* `size` is how much of the rise is still there ten
seconds later, clamped to 1. A hold of 1 means the music settles at twice what it rose from,
which is also the corpus median, so half of all tracks still reach full size and a flat track
can no longer invent a drop out of the best thing it has.

It used to be `hold / Math.max(1, ...holds)`, which is only half of that. The ceiling was
fixed; the divisor was not, so **48 of 91 tracks — every one whose best hold went above 1 —
still divided all their moments by their own best**, the exact normalisation the comment above
the line says was removed, pointing the other way. Measured by running the same detector with
the divisor pinned: 47 of 345 moments came out more than 0.15 smaller than they should, p90
0.18, worst 0.61. On Ecophony Rinne the sizes were `0.23 1 0.39 0.17 0.04` where the fixed
reference gives `0.59 1 1 0.46 0.1` — a genuinely full-size moment shipping at 0.39 because a
bigger one exists elsewhere in the track. After: median size over the corpus 0.43 → **0.50**,
same 46 of 91 tracks at full size.

### 2.4b Does any of this survive a modern master?

The whole structural layer reads loudness, and a chart pop master has had its dynamics squeezed
out deliberately. That is the standing objection to everything in §2, and it is what the pop
tracks in the set are for. Measured across all 81, bucketed by how hot the master is:

| master | tracks | moments found (p5/p50/p95) | tracks with none | segment range within the track | section spread |
|---|---|---|---|---|---|
| louder than −4 dB | 11 | 1 / **4** / 5 | **0** | 10.9 dB | 23.1 dB |
| −4 to −6 dB | 36 | 2 / **4** / 5 | **0** | 13.6 dB | 11.4 dB |
| −6 to −8 dB | 24 | 2 / **4** / 5 | **0** | 15.1 dB | 12.1 dB |
| quieter than −8 dB | 10 | 1 / **5** / 5 | **0** | 14.7 dB | 15.1 dB |
| **all** | **81** | 2 / **4** / 5 | **0** | 13.8 dB | 12.6 dB |

**`findRises` fires on every one of the 81 tracks, and the hottest masters do as well as the
quietest.** A track mastered at −1.9 dB still has about 11 dB between its quiet and loud
segments; compression flattens the *average* level, not the moment-to-moment range, and every
measurement here is against the track's own distribution rather than an absolute.

This is the counter-evidence to the assumption that killed three earlier detectors — "a track
that is loud from beginning to end has no loudness event at its chorus". That is true of the
*track average* and false of the segments inside it.

### 2.4c What our own slow signals actually span

A coefficient written against `0..1` is a claim about a signal's range, and two of the ones
`layers2` leans on hardest do not have that range. Measured over 91 dumps at 60 fps, driving the
production normalisation:

| signal | what the code assumes | what it measures |
|---|---|---|
| `loudness` (centred window) | 0..1 | max over the whole corpus **0.84**; per track the maximum is usually 0.6–0.72 |
| `slowBand` (10 s follower over it, `layers2`) | 0..1 | **maximum 0.564 across every track measured**, p50 of the per-track maxima ≈ 0.5 |

So `sectionPower = 0.78 + slowBand * 0.45` spans 0.87–1.03 in practice, not 0.78–1.23: an 8%
swing where the code reads like a 58% one. `inSky = perc.length * (0.35 + slowBand * 0.75)`
spans about half to three quarters of the pool, never the 35–110% the arithmetic allows — which
is also why the `perc[pi]` read past the end of the array never happened before the `Math.min`
went in.

This is DESIGN-RULES §12 in its cheapest form: before tuning a coefficient, print the
distribution of what it multiplies.

### 2.5 The per-moment signals

`energy`, `pop`, `strike`, `beatStrength`, `attackSharpness`, `glow`, `harmonicShift`,
`level`, `trend` — documented in `SIGNALS.md`. The trust notes worth repeating here:

| signal | trust |
|---|---|
| `energy` | high — normalised loudness curve, nothing inferred |
| `level` / `trend` | high — 20 s and 2 s averages of the same curve. `trend` is the only honest "is this building or settling" we have |
| `strike` | good — fires on real transients rather than on the beat grid, so it follows a track that does not keep strict time |
| `beatStrength` | depends entirely on `bars`; see §1.2 |
| `attackSharpness` | **texture only.** See `loudness_max_time` |
| `harmonicShift` | moderate — a continuous tonal centre over all 12 classes, not an argmax. The argmax version was a step function and produced a bang-bang controller |
| `pop` | high, but it is a *pulse* — it says a beat happened, not that it mattered |

---

### 2.6 The chroma's tonal centre, and what `harmonicShift` is not

Built for Plate, where the harmony has to choose a shape, and worth keeping because both
halves are traps.

**The angle of a weak resultant is noise.** The obvious tonal centre is the circular mean
of the twelve pitch classes — sum them as vectors on the circle and take the angle. On
real tracks that angle covered the ENTIRE ring over one song and moved a quarter of it in
any given second, whether the harmony had moved or not, because a chroma that is nearly
flat has no centre and asking for one anyway returns the direction of the noise. Two
things fix it, and both are needed: ease the VECTOR rather than the angle (§1c — an angle
must never be smoothed as a number), and gate what it drives by the vector's own LENGTH,
which is exactly the confidence that the centre means anything. `gustCoherence` exists
for the same reason on the input side.

**`harmonicShift` is not "the tonal centre moved".** It is the cosine distance between
consecutive segments' chroma vectors, which a change in level or in timbral balance moves
just as readily as a change of chord. Measured on three tracks: in the second after a
`harmonicShift` spike, the tonal centre moves **no further than in a quiet second before
it** (0.154 of the ring against 0.178 on Borderline; 0.102 against 0.121 on Charlie's
Inferno). So the two are usable for different things — `harmonicShift` says *something
changed in the harmony's spectrum*, which is the right trigger for unlocking a rate cap,
and it does not say *the music moved to a different chord*.

**And a per-segment rank is an envelope, not a level.** `rankOf(timbreSorted, timbre[1])`
jumps across the full 0..1 range several times a second, so anything structural that
reads it directly is being driven by the segmentation rather than by the music (§5a).
Plate eases it over about a second.

---

## 3. The graveyard

Measurements that were tried and do not work. Each cost at least one round trip.

| attempt | what happened |
|---|---|
| `loudness_max_time` as a percussion isolator | the segment describes the mix, not the drum. Three attempts |
| absolute dB thresholds | failed three times. A −20 dB outro destroyed the scaled version |
| chorus from loudness (3 versions) | 2 accurate hits in 11 firings over six tracks. A track that is loud throughout has no loudness event at its chorus |
| chorus from repetition (chroma + timbre) | fired wrong more often than right; a chorus landed *better* on a track where it stayed silent. Code kept, `ENABLED = false` |
| `min(1, amplitude × 1.8)` | a ceiling inside a comparison — see §2.2 and DESIGN-RULES §3c |
| the `arrival` heuristic | a hand-made online detector driving both brightness and speed. Fired 8–80 times a track, twice inside one second. Replaced by §2.4 |
| validating a detector on synthetic audio | scored 3/3 on data generated to match its own assumptions, then found a whole song to be one chorus |
| scoring a detector against labels it produced | one track's "ear labels" were the times the visualiser had fired |

---

## 4. Open

1. **`rhythmstring` band 0** (§1.5) — 65 % beat recall against the segment starts' 55 %, and
   69 % of downbeats against band 7's 43 %. Frequency-limited, which `segments` can never be.
   Next: measure its **precision**, since 2.9 events a second could score on recall by density
   alone. If it holds, it is the low-end event source this project has been missing.
2. **`timbre[1]` and `timbre[2]`** — the two widest coefficients, and [2] is independent of
   loudness (r = 0.06) with a 160-wide range. Read by almost nothing.
3. **`segment.confidence`** — p5/p50/p95 = 0.07/0.50/1.00, the full range, and unread. The
   obvious missing weight in `hitScale` and in the star's gate.
4. **`start_of_fade_out`** — a real fade on 22 of 25 tracks, median 8.4 s. Free, exact, unused.
5. **Track-level `time_signature`** — median confidence 1.00, and everything metrical here
   quietly assumes 4/4. (Per-section metre is noise: 27 of 81 tracks contradict themselves.)
6. **`beat.confidence`** — predicts which tracks have an untrustworthy grid, demonstrably
   (r = 0.50 against rhythm-event clustering over 81 tracks), and nothing reads it.
7. **`synchstring`** — the fourth encoded blob, decodes the same way, never examined.
8. **`audio-features`' `valence` and `energy`** — the only per-track *character* available, and
   the only thing at all when the analysis 404s.


---

## 6. What the analysis will not tell us — measured, 2026-08-30/31

Four things were tried, measured and rejected. They are recorded because each looks
obviously available until it is checked.

### Register, i.e. how high a sound is

Not available for the events we draw.

- `pitches` is chroma — the note without the octave. A low C and a high C are the
  same twelve numbers.
- The rhythm bands cannot do it either. Across **26 468 hits**: 67% touch the lowest
  band, 77% touch the highest, and **48% touch both at once** — because the detector
  selects broadband onsets by design and a broadband sound has no register. The band
  centroid spans only 2.3–5.0 of a possible 7 for 80% of hits.
- The two candidate measures disagree completely: band centroid against the
  segment's own `timbre[1]`, **r = 0.07**.

What does exist is `timbre[1]` — "how ringing was that sound", dull thud against
bright ring rather than low against high. It is the better of the two on both counts
that matter: consecutive hits differ by 19% of its range at the median (against 14%
for the bands) and any ten seconds covers 68% of it (against 43%). It describes the
whole segment, i.e. the mix, not one sound — the same limitation as the attack time.

**Use it by RANK within the track, never by value.** The raw numbers are bell-shaped:
placing marks linearly left them bunched in the middle, spread 0.27 of the half-width
against 0.58 for a uniform spread. By rank it is 0.42–0.50.

### Where the drums are

Not available. Every band's own onset rate is pinned: on 一緒なら the low band runs at
8.5 events a second from the first bar to the last and never moves, which matches the
2.7 / 2.9 / 3.2 per second measured across 81 dumps in §1.5. Texture has to be read
from segment density and loudness instead.

### `loudness_end`

Zero on **93.7%** of all segments. It is used in exactly one place — the final point
of the loudness curve — and the LAST segment of all 91 dumps carries a real value, so
nothing is currently broken. One field away from being a ghost.

### The width of a mark, from the attack alone

`timbre[1]` aside, this is a measurement about our own drawing rather than about the
music, but it belongs here because it was invisible without measuring. Width came
only from how broadband the attack was — and 45% of sounds have no broadband attack,
so **63% of all marks were drawn at exactly the minimum width**. Half the picture was
pinned against a floor. Reading how *gently* the sound began as well moved the median
width from 0.30 to 0.95 and the share at the floor to 0%, and — the reason it
mattered — took the visible light events from 1.2 to 2.2–2.7 per second and the share
of beats producing one from 19–22% to 34–37%.
