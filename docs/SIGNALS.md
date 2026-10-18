# Signal reference

Every field on `Conductor`, where it comes from, and how fast it moves.
Produced once per frame by `createConductor()` in `src/presets/flowfield-common.ts`.

Presets should read these and never recompute them. If a preset needs a new
derived signal, it goes here, not into that preset.

**Easing convention.** Everything uses the same shape:

```ts
value += (target - value) * Math.min(1, rate * dt)
```

`rate` is per second. Asymmetric rates (attack ≠ decay) are written `↑a ↓b`.
The `Math.min(1, ...)` clamp is what makes it frame-rate independent and stops
overshoot on a long frame.

**`dt` is clamped to 50 ms.** A backgrounded tab or a stall cannot fast-forward
the whole simulation on the next frame.

---

## Audio signals

| field | source | easing | meaning |
|---|---|---|---|
| `energy` | `sampleCurve(loudnessCurve, t)` | none (sampled) | loudness, 0..1 — but **per-segment attack/decay, not a level**: it reverses 3.8x/s. Brightness, width and spawn rate only. Falls back to a gentle sine when the track has no analysis |
| `loudness` | a CENTRED window over the curve, 1.5 beats of this track wide | none — no lag by construction | the loudness now, without the sawtooth. **Anything that sets a speed reads this** — DESIGN-RULES §5a. It was an exponential follower until 2026-08-30; a follower is late by its own time constant, which showed up as the field accelerating up to 2.9s after a drop. The analysis is a timeline, so the delay is avoidable — see §5b, applied to a level rather than an event |
| `momentum` | `energy` + beat amplitude | ↑4 ↓0.4 | loudness accumulator. Fast attack, slow release — the ambient "how hard is this section pushing" |
| `pop` | beat hit (1) or segment change (0.5) | ↑30 ↓8 | the crisp *you can see the beat* layer. ~30 ms attack, ~120 ms decay, so consecutive hits stay distinct where `momentum` would smear them |
| `glow` | `momentum * 0.7 + energy * 0.25`, floor 0.22 | ↑4 ↓0.5 | brightness/line-width driver. **Audio only — never gestures** (see DESIGN-RULES §2) |
| `brightness` | `timbre[1] / 100` | 0.8 | spectral brightness, −1..1 |
| `attackSharpness` | `1 - loudness_max_time / 0.25` | 6 | how percussive the current segment is. Fast rise (drum, pluck) → 1; slow swell (pad, bowed note, held vocal) → 0. Updates on segment change only |
| `harmonicShift` | cosine distance between this and the previous segment's `pitches[12]`, ×2.5 | ↑25 ↓7 | fires when the *harmony actually moves*. A held chord stays near 0; a chord change or key shift spikes. Distinct from `pop`, which fires on any beat regardless of harmonic content |
| `trend` | fast(~2 s) − slow(~20 s) energy average | — | `+` while a section builds, `−` while it settles |
| `level` | slow(~20 s) energy average | — | how loud this whole stretch is |
| `segment` | `segmentAt(segments, t)` | — | raw current segment, or `null` |
| `beatHit` | — | — | true on exactly the frame a beat starts |
| `beatStrength` | `bars` vs `beats` | none (held per beat) | **1 on a beat that starts a bar, 0.45 on one that does not**, 0.7 when the track has no bars. Metrical weight, not loudness. `pop` is scaled by it, so a downbeat lands harder than an offbeat |
| `strike` | segment start, gated by `rhythmstring` band agreement | none (one frame) | a HIT: a segment where at least three of the eight rhythm bands fire together. 48% precision / 44% beat recall against the old 28% / 51%. Strength is the band count — see rhythm.ts |
| `lookAhead(sec)` | the next segment, if it starts within `sec` | — | `{ inSeconds, power, sharpness, downbeat }` for the hit that is **coming**, or `null`. `inSeconds` counts to the segment's *peak* (`loudness_max_time`), not its start, so an event can be launched early and land its own peak on the hit. `power` is amplitude over the track's `hitScale` and is **deliberately unclamped** — see DESIGN-RULES §3c. Use `downbeat` rather than `beatStrength` when acting before a beat: `beatStrength` describes the last one |
| `timeToImpact` | `findMoments` in `track-structure.ts` | — | seconds until the track's next big moment, or `null`. **The only signal that looks forward** |
| `runInDip` | measured per moment | 4 | how far the music itself thins out on the way in, 0..1. High → follow it down |
| `runInBuild` | measured per moment | 4 | how much it climbs on the way in, 0..1. High → wind up instead of withdrawing |
| `anticipation` | `timeToImpact` | ↑3 ↓9 | 0..1 over the moment's OWN measured run-in (`leadSeconds`, 1.2–8 s — see the caveat under `leadSeconds` below), released at it. Pull back on this — contract, dim, slow — so the boundary lands on something that made room for it |
| `impact` | the moment, as a SHAPE IN TIME | none — a function of `timeToImpact`, rise 0.7 s / fall 1.8 s | swells INTO the moment so its peak lands on it, then falls away. Not a filter chasing a pulse: the moments are known for the whole track at load, so the envelope is frame-rate independent and peaks exactly where it is aimed (DESIGN-RULES §5b). Scaled by the moment's size |
| `drumming` | *(preset-local, in Layers)* | ×0.3/s | how much drumming has happened **recently**, not how hard the last hit was. A fast run compounds; a lone hit every two seconds never accumulates. Measured effect: 28× the light for 16× the hit rate, against 8× when hits merely replaced each other |
| `sectionIntensity` | section loudness **rank** within the track | 0.14 (~7 s) | 0 at this track's quietest passage, 1 at its biggest. Spend a budget on this — particles, size, brightness — rather than spreading it evenly over a track that is not evenly interesting |

**Between tracks** (2026-10-02). `energy` and `loudness` are never handed a new track's
value at once. While the next analysis loads they breathe out towards 0.12 instead of
following the fallback sine (which climbed: 0.45 → 0.56 in half a second, louder than
the song that had just ended), and they come round to the new track's own level over
1.5 s (assigned, it fell 0.56 → 0.10 in one frame and every speed in the picture with
it). Only a track with no analysis after 3 s gets the sine. The app also fetches the
next track's analysis ahead of time, so a natural advance has no wait at all, and the
album colour goes straight from one cover's to the next over ~2 s rather than by way
of the default. `npm run check` asserts the level neither climbs nor steps.

## Gesture signals

| field | source | easing | meaning |
|---|---|---|---|
| `gustAngle` | `atan2` of the eased movement-direction vector | 10 (on the vector) | which way the cursor is moving |
| `gustStrength` | `moveSpeed / (scale * 0.4)`, capped 3 | ↑6 ↓2.5 | how hard. **Saturates at its cap during any vigorous movement** — deliberate or not |
| `gustCoherence` | magnitude of that same eased direction vector | — | how *consistent* the direction has been, 0..1. Steady direction → ~1; circles or random motion partly cancel → toward 0. **Use this to gate anything that should respond to a real gesture rather than to "the cursor is moving fast"** |
| `chaos` | downward flick speed / `scale * 2.2` | ↑6 ↓3 | field goes busy, high-frequency, hazy |
| `order` | upward flick speed / `scale * 2.2` | ↑6 ↓3 | field goes laminar, clean, sharp |
| `chaosTotal` / `orderTotal` | pulse + slow baseline | baseline ↑1/6 ↓1/45 | **read these for structure.** Repeated flicking builds a baseline over tens of seconds that decays over ~45 s, so conducting leaves the piece changed for a while instead of evaporating the instant the flick ends |
| `baton` | how fast the pointer is moving **now**, against twice the picture's short side per bar of this track | ↑80 ms ↓ one bar | **conducting.** A magnitude with no position and no direction in it — the same number over the whole picture, so it cannot make a bright place and cannot bend a trail. 0 with the pointer at rest, and at 0 every preset is exactly what it was before this existed. Layers II widens its dynamic *range* with it (the loudness-dependent half of each speed, never the level, never alpha). Up in eighty milliseconds and down on the music's clock: measured, the hand starts moving and the baton is past 0.5 in **50 ms** and past 0.9 in 167 ms. It was an accumulator over a bar eased over another one, and two bars of lag on the answer to your own hand read as dead — instant and stepping are not the same thing. Measured: a pointer teleporting to a random point every frame produces the same numbers as a smooth sweep — 0 turns over 0.3 rad, same worst one-frame speed change — because the human clock never reaches the picture |
| `hand` | the same rate, let go over a **beat** | ↑80 ms ↓ one beat | the quick half of the gesture. Two envelopes off one input so the channels they drive stay separate rather than fusing into one knob pushed twice. Layers II gives it the number of marks an event throws |
| `trailAt(x, y)` | the pointer's recent path, laid down BY DISTANCE (a point every radius/8 of travel), each point fading over 1.2 beats | per point, 1.2 beats | how brightly the hand's ribbon passes through (x, y), 0..1. Reach is 0.17 of the short side. The one narrow place DESIGN-RULES §2 lets a gesture into brightness, and built to its terms: it lights a particle that is ALREADY THERE and never draws a shape of its own, so a still hand — which lays no points — does nothing at all. Layers II multiplies it by `baton` for the field and by `hand` for the marks, and uses the product as brightness, as a turbulence AMPLITUDE and as a speed multiplier. Never as an angle: the trail is sampled from raw pointer position, which is exactly what §1b forbids in geometry |
| `rippleAt(x, y)` | a click, as a glow where it landed plus a ring spreading out of it | glow one beat, ring one bar | the ring crosses the picture's short side in a beat and a half and the whole thing is gone in a bar, so a click spreads slowly on a slow track. **Light only — not speed, and not turbulence either.** The band is narrow and travels at about 1100 px/s, so anything reading it changes fast; brightness may do that (§1b), a stroke length may not, and turbulence is an amplitude on the noise that sets the angle. Measured with the ripple in the turbulence: three turns over 0.3 rad in a 41 s run, the only non-zero this preset has ever produced. The hand's own ribbon may stir, because it is broad and moves with the hand; a shockwave may not. Measured, clicking once a bar: 10.8% of the light on screen, strokes at the alpha ceiling 0.09% → 0.43%, turns over 0.3 rad 0 |
| `clicked` / `rightClicked` | cumulative counter changed | — | true on exactly the frame of a click. Trigger one-shots off these |
| `speedFader` | `0.35 + scrollSmooth * 1.6` | 1.8 (on scroll) | global speed multiplier |
| `yAttraction` | `1 - (mouse.y / height) * 2` | none | +1 top (attract) .. −1 bottom (repel) |

## The brace the music makes itself

A chorus was reported as landing perfectly on a track whose only distinguishing
feature is a genuine lull before it — with the chorus detector silent, nothing
predicting anything. That is the mechanism worth having, and Layers now builds its
withdraw-and-release from two readings of the track against itself rather than from
any forecast:

- **lull** — `trend`, this moment's energy against the last twenty seconds. A quiet
  passage drives it negative. It is a *state*, so it is read slowly and its depth is
  capped: at full strength it left a quiet passage at a seventeenth of a chorus's
  light, which is switching off rather than restraint.
- **arrival** — the same comparison at a third of a second's smoothing, and taken as
  the **rise** rather than the level. Held as a level it stayed positive for the
  twenty seconds the slow average needs to catch up, so the overshoot lasted the
  whole chorus and sat on the ceiling; an arrival that never stops arriving is just
  a brighter mix.

Neither can fire in the wrong place, because neither is predicting a place.

**Measured against real tracks and real labels, this beats the detector outright.**
Driving the preset with eight dumped analyses and looking at where each track's
single largest change of speed falls: six of the eight land on a chorus the listener
had marked — asphyxia 15 s against 14, UNDEAD 60 against 60, daidai naru 89 against
88, 神様 116 against 116, Daten 126 against 125, 一緒なら 76 against 75. The two
misses are mild (1.37× and 1.52×). No prediction, no labels, no detector.

The gain on the arrival matters more than it looks. At a floor of 0.35 and a gain of
0.9 an energy rise of a *tenth* produced a release of 0.7 — most of a chorus's worth
of jolt for an ordinary crescendo, which is what was reported as speed flashes. On
一緒なら it put a 2.07× speed jump at 47 s where nothing happens. At a floor of 2.5
and a gain of 0.3 that same spot is 1.37×, while the track's real chorus at 75 s
keeps a 1.99× jump — the biggest in the track.

And the release drives speed at less than half its old weight. Every complaint about
this mechanic has named *speed*; brightness and width can carry a jolt without
looking like a malfunction, and speed cannot.

## Looking forward

`anticipation` is the first signal in the project that depends on the future rather
than the present, and it exists because the analysis was already carrying the answer.
`sections[]` — start, duration and **loudness** for every part of the track — arrives
with every analysed track and was discarded for the whole life of the project, along
with `bars[]`. Declaring them in `SpotifyAudioAnalysis` was the entire cost.

Note the deliberate absence of a chorus detector. "The next section is measurably
louder" needs no classification, no self-similarity matrix and no confidence
threshold, and it fires on the thing that actually matters visually — the moment the
music gets bigger — whether that section is a chorus, a drop or a final refrain.

Two limits worth knowing:

**A beat is not a hit.** Beats come from a tempo grid the tracker fits over the
track. On music that does not keep a regular metre — math rock, odd time, rubato —
that is a regular pulse laid over an irregular piece, and percussion fired from it
looks exactly as wrong as that sounds. `strike` comes from `segments` instead:
timbral events measured from the audio, which follow the music whatever it does with
its bar lines. On ordinary music the two coincide, because a kick makes a sharp
segment. Layers ignites on `strike`; `pop` and `beatStrength` still use the grid,
which is right for a visual pulse.

**Loudness cannot find a chorus, and three versions proved it.** Section loudness,
section loudness ranked, and then the loudness envelope at fine resolution — the same
evidence measured three ways, scoring 2 accurate hits out of 11 firings across six
real tracks. The counter-example that settles it is a track that is loud from
beginning to end: it has no loudness event at its chorus. Mastering compresses
dynamics deliberately, destroying exactly the signal those versions relied on.

What distinguishes a chorus is that **it comes back**, which is a question about
harmony and timbre. `track-structure.ts` builds per-bar vectors from `pitches[12]`
and `timbre[]`, compares every bar with every other, finds boundaries with a
checkerboard novelty kernel (Foote), then — and this part matters — **groups the
blocks those boundaries open and picks the group that repeats while being loud and
bright.** Boundaries alone are not enough: novelty is exactly as high where a chorus
*ends* as where it begins, so a boundary list produced one spurious firing for every
real one. When nothing repeats convincingly it returns nothing at all.

Measured on synthetic songs with known structure: 3/3 choruses with 0 spurious on
normal dynamics, 3/3 with 0 spurious on a track that is loud throughout, and silence
on a through-composed piece that never repeats.

**The run-in is measured, never assumed.** Tracks differ — some build for six
seconds, some cut to near-silence for two, some simply arrive — so `leadSeconds`,
`runInDip` and `runInBuild` come from the envelope around each moment individually.
A fixed 4.5 s dim was wrong on most songs: it dimmed through tracks that were already
dimming and dimmed through tracks that were accelerating.

**…and measured off a one-second mean, not off the curve.** All three read the
loudness curve, which is a per-segment sawtooth (DESIGN-RULES §5a), and all three ask
about the shape of the music over seconds. Asked of the raw curve they answered about
the ripple instead: `build` sat at its ceiling for **34%** of all 348 moments across
89 dumps, and `leadSeconds` — implemented as "how long since the level last looked
normal" — reported the shortest lead-in the clamp allows for **half** of them, because
a sawtooth crosses its own mean several times a second. Smoothed first, the same 348
moments give `dip` 0.58 → 0.35 mean and `build` 0.68 → 0.36, with the ceiling share
down to 12%; correlation with the old values is 0.79 and 0.67, so this is not a
rescale, it is a re-ranking. Anything the presets multiply by `runInDip` therefore
reads softer than before — deliberately, since the missing part was ripple.

**And the measurement is not overridden afterwards.** `windup` used to floor its span
at 3.5 s, so for the half of moments whose measured run-in is the minimum, the field
accelerated for three and a half seconds into music that had prepared for one. It now
uses `leadSeconds` as given. Reported as "misplaced acceleration" on Borderline at
0:19, whose run-in measures 1.2 s and whose `build` is 0.17: the music does not build
into that moment at all, it dips and arrives.

**A run-in may touch the track's usual level on its way in — fixed 2026-09-16.**
Re-measured against the shipping code, 345 moments over 91 dumps: **49% came back at
the 1.2 s clamp minimum**, which the one-second mean had not helped at all. But for
exactly those moments the music is away from its own baseline for a MEDIAN 53% of the
eight seconds before, earliest deviation 7.75 s out. The run-in was there every time.
What the loop reported was the last moment the music looked NORMAL, and it walks to
within a quarter second of the downbeat — so the breath immediately before a drop, the
bar where a track drops back to its usual level before it lands, reset the answer.
Median raw value for those moments: 0.25 s exactly.

So "half of all moments have no run-in" was never the finding. The finding is that a
run-in is not obliged to be CONTIGUOUS up to the downbeat and the measurement assumed
it was. Only a SUSTAINED return ends it now, and sustained is **one beat of this
track** — the bar grid the analysis already sends, four to a bar. Measured over the
same 345 moments: the clamp share goes **49% → 29%** and the median lead **1.25 s →
3.0 s**. Longer tolerances keep going (half a bar gives 16%) and buy nothing, because
they move the same mass onto the ceiling instead — and 8 s is the width of the
look-back window, not a measurement. **19% of moments now report exactly 8 s**, which
means "longer than we looked".

**Section boundaries are not song form.** Three attempts derived the forward-looking
moments from `sections` and all three failed on real tracks, the last one instructive:
on Charlie's Inferno the choruses are at 1:06 and 2:25 and the nearest section
boundaries are at 0:55 and 2:27 — one ten seconds early, the other two and a half
late, which put the run-up's dimming *on top of* the chorus it was introducing.
`sections` segments by timbre and loudness; it is not a map of song form and no
threshold makes it into one.

`findImpacts` reads the loudness envelope at the segments' own ~0.3 s resolution
instead: compare the six seconds ahead against the six behind and take the peaks,
weighted by the level they arrive at. The weighting matters — across a long crescendo
the rise is roughly constant, so an unweighted peak lands arbitrarily in the middle
of the build rather than at its resolution. Then snap forward to the next bar line
within 2.2 s, because a chorus arrives on a downbeat while the envelope starts rising
with whatever leads into it.

**Two absolute thresholds died here, and the lesson is the same one as the live tap's
auto-gain.** Loudness in dB is a property of the *mastering*, not of the music:

- A flat "2.5 dB louder" never fired once across five real tracks. Modern masters put
  a chorus about a decibel over a verse.
- Scaling the threshold to the track's dB *range* fired even less, because a range is
  set by whichever outlier is largest. One −20 dB fade-out at the end of Charlie's
  Inferno pushed its threshold to 5.6 dB and nothing in the song ever cleared it.

What works is **rank**: each section's position among this track's own sections,
which is immune to compression and to outliers, plus a small absolute floor so a
track whose sections are all within noise of each other does not read rank noise as
structure. The same reasoning normalises `energy` itself — see §4.1's per-track
loudness normalisation, without which a track mastered at −13 dB rendered as a
permanent interlude no matter what happened in it.

- **Tracks without analysis have no sections**, so `anticipation` stays at 0 there and
  `timeToImpact` is always `null`. The audio-features fallback (§4.1) gives a tempo
  grid, never structure.
- The music is usually *already* thinning out before a chorus. Anything reading
  `anticipation` compounds with a real drop in energy, so the withdrawal must be
  capped well under 1 — at full strength the two together take the screen to black
  and the release becomes a fade-up from nothing instead of a release.

## Frame constants

| field | meaning |
|---|---|
| `dt` | seconds since last rendered frame, clamped to 0.05 |
| `scale` | `min(width, height)` — use for all size-relative constants so behaviour is resolution-independent |
| `wander` | slow ~2-minute sine, independent of audio and gesture, so a preset never sits at one resting point for a whole song |

---

## Why `gustCoherence` exists

`gustStrength` conflates *how fast* with *how directionally confident*. Real
telemetry showed it pinned near its cap for a sustained 1.5 s stretch of
ordinary "moving to the music" — which meant anything weighting it heavily was
being yanked around continuously rather than only on a real gesture.

Measured on that recording: gating by `gustCoherence` dropped the fraction of
the session with a high motion response from **93.2 % → 24.7 %**, while leaving
deliberate swipes intact.

**Rule of thumb:** if a signal should fire on a *gesture*, multiply by
`gustCoherence`. If it should fire on *motion of any kind*, don't.

---

## Adding a signal

1. It must come from **real per-track data or real input** — not an invented
   heuristic. Spotify's analysis is rich; check `segments[]` before inventing.
2. Add the state, the target, and the ease inside `createConductor()`.
3. Add it to the `Conductor` type with a comment saying what it *means*
   musically, not what it computes.
4. Add a row here.
5. Signals derived from audio may drive brightness. Signals derived from
   gestures **may not** — see [`DESIGN-RULES.md`](DESIGN-RULES.md) §2.
