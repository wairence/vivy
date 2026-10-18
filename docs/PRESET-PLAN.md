# The next two presets

**Both were built on 2026-09-17, the same day this was written.** They ship as `smoke`
and `plate`; what the phases below actually measured is recorded in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §7.4 and §7.5, and the two findings about the
analysis that came out of building Plate are in [`MEASUREMENTS.md`](MEASUREMENTS.md)
§2.6. This document is kept as written, because the value of a plan is partly in seeing
where it was wrong:

- **Phase 0 was worth more than expected.** The harness could not see a pixel at all, and
  fixing that turned up that `music-lab.js` and `measure-motion.js` were equally blind —
  two of the five presets measured as zero light in the tools that exist to measure them.
- **Smoke's stated trap was not the one that bit.** Injecting force along the pointer's
  movement was never written; what went wrong instead was the wind having no steady
  state, the mean flow and its fluctuations being relaxed together, and the loudness
  ending up in two channels at once.
- **Plate's stated risk — that a settled figure reads as broken — never arrived.** The
  real one was that the thing the figure chases, the chroma's tonal centre, is unstable
  in exactly the way §1c warns about, and that `harmonicShift` does not mean what the
  plan assumed it meant.

---

Written 2026-09-17. Five concepts were weighed; two were chosen and are planned here.
The rules they have to satisfy are in [`DESIGN-RULES.md`](DESIGN-RULES.md); the signals
they may read are in [`SIGNALS.md`](SIGNALS.md); what the analysis can and cannot tell
us is in [`MEASUREMENTS.md`](MEASUREMENTS.md).

The frame for all of it, from DESIGN-RULES §8: **port proven work, translate a real
algorithm — do not improvise an original one.** Every preset in the repository today is
particles advected by a noise field, plus one ring preset and one instrument. Both
choices below bring a material this project does not have, and both are structurally
incapable of the discontinuity that has cost this project six rounds: they move by the
gradient of a field, never by a direction handed to a particle.

---

## The five that were weighed

| | what it is | the musical question it answers | why / why not |
|---|---|---|---|
| **Smoke** | Stable Fluids (Stam, 1999) — advect + project on a coarse grid, dye carried by a real velocity field | **force and event**: a sound is an impulse, and the room remembers it | chosen. The most portable algorithm in the field, and a genuinely new material: volume that mixes itself rather than filaments |
| **Plate** | Chladni figures — sand settling on the nodal lines of a vibrating plate | **harmony and register**, which is the channel Layers II admits it cannot show | chosen. Closed-form physics, literally a picture of sound, and gradient descent cannot produce a corner |
| **Feedback** | Milkdrop's per-frame model: last frame drawn into itself with a warp, a curve on top — but the curve is the loudness of the **next two seconds**, which is a thing only a timeline can draw | **what is about to happen** | deferred. It is a direct fight with §4 (never re-blur accumulated history) and §4b (the 11/255 floor). Worth doing, not first |
| **Growth** | Gray–Scott reaction–diffusion | state, not events — texture that grows | deferred. Beautiful and slow by nature; an event cannot be read in it. This is a GROUND layer, not a preset |
| **Ensemble** | Kuramoto coupled oscillators, natural frequencies from `beats`/`bars`/`tatums` | **metre, and how the music pulls itself into time** — the only idea here that is not about loudness | deferred. Prototype it as a `signal-scope` lane first and see whether synchronisation reads at all |

---

## Smoke — Stable Fluids

A velocity field on a coarse grid (128×72 to start), a dye field carried by it. Every
sound is an impulse of force and a puff of dye; the wind carries them; the room keeps
the mixing for a few bars. What the eye gets is a material that has **momentum** — the
one thing a noise field can never have, because a noise field's particles have no
history beyond their own trail.

### Phase 0 — the harness, first

`check-presets.js` records `putImageData` as `[object Object]`. For a pixel preset that
means **the finite-number check never sees a pixel and the freeze-on-pause invariant is
not tested at all** — a NaN in the solver would pass silently, and so would a frame that
keeps simulating while paused. Before any solver code: teach `record` to hash
`ImageData.data` and to assert the pixels are finite.

*Gate:* deliberately break a frame (inject a NaN, advance the solver on a paused frame)
and confirm `npm run check` fails on both.

### Phase 1 — the solver, with no music in it

Stam verbatim: advect velocity, project (Jacobi, ~20 iterations), advect dye, dissipate.
One constant wind. Render by `putImageData` into a small offscreen canvas and
`drawImage` it up with smoothing on.

*Gates:* `npm run check` green including the new hash; 60 fps at 128×72 in the preview
harness; total dye bounded over three minutes (it must not accumulate); no cell ever
NaN.

### Phase 2 — the music, one driver per channel (§12)

| channel | driver | note |
|---|---|---|
| where a puff is born | register, across the wind | reuse the placement Layers II already measures — `rankOf(timbreSorted, timbre[1])` |
| when | `lead` seconds **before** the sound | §5b. `min(0.4, rise × 0.9)` from the next segment, as in Layers II |
| how big the puff and its impulse | `hitAmp` over `hitScale`, and `breadth` | never `energy` |
| the wind's speed | `c.loudness`, and nothing else | §5a |
| vorticity (how much it curls) | `attackSharpness` | a scalar amplitude on curl that already exists |
| dissipation | up under the brace, so the room thins on the way in | in beats of the track |
| the release | one large injection on `impact` | it is a big hit, not a separate mechanism |

*Gate:* `node music-lab.js "<track>" --picture` — light correlates with the music at
r ≥ 0.85, motion ≥ 0.6, and the picture's total range is **no more than twice the
music's own** (§13; the last preset's failure was here, not in the correlations).

### Phase 3 — the hand

`trailAt × baton` raises **local vorticity gain** — an amplification of curl that is
already there. Nothing else.

**The trap, stated plainly so nobody walks into it:** injecting force along the
pointer's movement direction is the most natural thing in the world to write in a fluid,
and it is exactly the raw-input-sets-direction failure of §1b, in the one place where
the medium remembers it for several seconds. A fluid does not forgive that the way a
particle does.

*Gate:* the §1d test — a pointer teleporting to a random point every frame must measure
the same as a smooth sweep.

### Phase 4 — the eye

Diagnostic palette (velocity / dye / vorticity drawn separately, on the same key as
Layers II's), then a verdict by ear and eye.

### The standing risk

Dye density **is** brightness, and the bloom multiplies it. The ceiling goes above the
measured p95 and never through the distribution (§3b), and the share of pixels sitting
on that ceiling is a number to watch from the first build, not after a complaint.

---

## Plate — Chladni figures

Sand on a vibrating plate collects where the plate is still. The field is closed-form:

```
S(x, y) = Σ aₖ · ( cos(nₖπx)·cos(mₖπy) − cos(mₖπx)·cos(nₖπy) )
```

Particles walk down `∇|S|` and jitter in proportion to `|S| × loudness` — which is the
actual physics, sand leaving the antinodes and piling up on the nodal lines.

### The mapping that makes it music

**Twelve modes, one per pitch class.** `aₖ` is that pitch class's live energy from
`createChromaTracker`. A chord physically shapes the figure; a chord change re-melts it
and it re-settles into a different one. Register (`timbreSorted` rank) chooses which
family of modes carries the weight: low modes are a coarse figure, high modes a fine
one.

**Interpolate amplitudes, never mode numbers.** `n` and `m` are integers, so a mapping
that moves them steps — and a rate-capped chase after a stepping target is the bang-bang
controller of §1c, measured at 4.1 reversals a second the last time this project did it.
An amplitude is continuous in an already-eased band energy, so there is no step to chase.

### Phases

1. **Field and settling.** Twelve modes from cosine tables, ~2000 particles on
   `−∇|S|` plus jitter. *Gates:* field evaluated in under 2 ms; particles settle onto
   the lines within a couple of seconds; and they must **not collapse into a point** —
   run the clustering check that caught the seam at the cursor.
2. **The music shapes the plate.** Bands → amplitudes, register → mode family.
   *Gates:* on a dump with a clear chord change the figure has visibly changed within
   half a bar and is still between changes; per-particle turn 0 above 0.3 rad.
3. **The event is a shake, not a new figure.** The pattern is the harmony; a hit is how
   hard the sand jumps. The brace calms the plate (the sand lies down and the lines go
   sharp — contraction that costs no light), the release shakes it. *Gates:* §13, and a
   quiet passage must not go empty.
4. **The eye.**

### The standing risk

It is a system that **converges**, and a converged picture in a quiet passage reads
either as calm or as broken. The mitigation is built in — the jitter is never zero and a
chord change re-melts the figure — but which of the two it reads as is a question for an
ear, not for a measurement.

---

## Order

Smoke's phase 0 is useful on its own (the harness is currently blind to pixels), and
Plate's phase 1 is the cheaper thing to look at. Both phase 1s are self-contained: they
can be seen in `npm run preview` before anything else is spent on them.
