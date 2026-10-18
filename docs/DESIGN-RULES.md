# Design rules

Every rule here was learned by shipping the opposite and watching it look wrong.
They are not style preferences. Read §1 and §2 before touching motion or colour.

---

## 1. Bend the field. Never chase a point.

**Rule:** a gesture may only apply a *bounded `lerpAngle` bend* to the direction
a particle is already travelling. It may never hand a particle a competing
direction vector, and never a direction that depends on the particle's own
position relative to the cursor.

**Why:** a position-dependent target — `atan2(cursorY - p.y, cursorX - p.x)`,
i.e. "aim at the cursor" — makes every affected particle's target *converge* on
one place. Particles that already share a heading (Aurora's parallel sheets,
but any dense field eventually) then align onto the same trajectory, and their
long-lived trails paint that as a bright seam or a clot at the cursor.

**The distinction that matters**, and that cost several failed attempts to find:

| target | position-dependent? | safe? |
|---|---|---|
| `atan2(dy, dx)` — aim at cursor | yes | **no** — converges |
| `gustAngle` — one shared direction, same value for every particle | no | yes, even weighted by proximity |

A bend toward a *uniform* direction is safe to apply locally, because nothing
about it depends on each particle's own angular relationship to the cursor.
Nearby particles all lean the same way instead of leaning toward each other.

### 1b. Raw input must never set direction.

A trail is a literal recording of its particle's angle history. Anything
recomputed *fresh from raw mouse state every frame*, with no easing of its own,
writes a kink straight into the geometry the moment a particle enters or leaves
its range. No multiplier tuning fixes this — the discontinuity is structural.

Scalar channels do not have this problem: speed, brightness, line width, and
particle count can all jitter without bending a trail.

**So:** direction comes only from already-eased sources (the field itself, the
sweep, the conductor's eased signals). If the cursor should have a *local*
effect, express it as a scalar — e.g. widen the local noise deviation
(turbulence), which can never point a particle somewhere the field was not
already going.

### 1c. Never blend two independent absolute angles.

`lerpAngle(a, b, t)` takes the shortest path, so as `b` passes the **antipode** of
`a` the shortest path flips sides and the result jumps by up to `2·π·t` in one
frame. It is not a tuning problem; the function is genuinely discontinuous there.

Measured in Layers, where the melody's frame was `lerpAngle(groundAngle,
melodyTilt, 0.4)` with `melodyTilt` an absolute angle derived from the chroma: the
frame jumped ~2.5 rad in a single frame, **5.5 times a second**, peaking at
154 rad/s where Aurora peaks at 0.79. That is what "particles with long trails
change direction out of nowhere" looks like from the inside.

**So:** one direction is primary; everything else is a **bounded offset** from it,
kept well under π and eased as a plain scalar. A scalar has no wraparound, so there
is nothing to flip. This is also why it is the right structure musically — one wind,
and each layer's identity is how far it wanders off it.

**Corollary:** a rate-capped chase after a *stepping* target is a bang-bang
controller — it sits pinned at its cap and reverses every time the target steps.
The melody's lean chased the argmax chroma pitch class and reversed 4.2 times a
second. Fixed by deriving a continuous quantity (all twelve bands weighted by their
position on the circle) instead of a discrete winner.

### The failure log

Four distinct attempts, all the same root cause, all reverted:

| attempt | symptom |
|---|---|
| per-particle vortex bend toward the cursor | bright seam / clot |
| angular-velocity ("spin") → deviation spread | visible banding, jarring transitions |
| global-only sweep nudge | *every* particle reacted, including ones nowhere near the cursor |
| proximity-gated bend toward `gustAngle` | still not smooth — §1b, raw proximity setting angle |
| repulsion from a passing percussion spark (Layers) | measured 1.03 rad of turn in one frame; summing the sparks as vectors instead made it 1.38 |

That last one is worth its own sentence, because it is the cleanest statement of the
rule. Repulsion **diverges**, so it cannot clot the way a bend toward a point does —
it looked safe. It was not, for a different reason: a push away from a *moving* point
sweeps through 180° as the point goes by, and its weight peaks exactly during the
sweep. No amount of smoothing removes that; it is what the geometry is. Re-expressed
as brightness and local turbulence — both scalars — the same effect measured 0.000%
corners.

### 1d. The resolution: input is a magnitude, on the music's clock.

Every one of the failures above is the same rule broken, and the rule itself has a
cause under it: **input is on a different clock.** A hand moves on human whim, the
picture moves on the music, and there is nothing musical for a human-timed change to
be smoothed against. That is why no multiplier ever fixed one of these.

So conducting, added 2026-09-02, is built the other way round. A conductor does not
make the sound — the score is written and the orchestra knows it, and the conductor
decides how widely it gets played. `Conductor.baton` therefore carries **only how
large the gesture is** — the rate the hand is moving at, against twice the picture's
short side per bar of this track — with no position and no direction in it. It may
drive speed, population and turbulence amplitude.

**And it answers at once.** The first build eased it over a bar and quantised a click
onto the next bar line, on the theory that input had to wait for the music. That does
not follow, and it read as dead: *instant and stepping are not the same thing.* A ramp
that begins on the frame of the movement and reaches its value in eighty milliseconds
is immediate to a hand and perfectly continuous to a trail. The rule was never about
latency — it was about direction. Fast rise, musical fall: measured at **50 ms to
half**, 167 ms to nine tenths, and a bar to let go.
It may not drive an angle (§1) and it may not drive alpha (§2), and because it is the
same number everywhere it cannot make a bright place either.

**The test that this passes and none of the earlier attempts could:** driven by a
pointer that teleports to a random point *every frame* — the most violent input
possible — the picture measures the same as under a smooth sweep. Zero turns above
0.3 rad in either, and the same worst one-frame speed change (x2.02). Human timing
does not reach the geometry at all.

Older approach, for the presets that still use it: cursor proximity scales the noise
deviation amplitude. Not validated against a fresh telemetry recording.

---

## 2. Gestures never drive brightness.

**Rule:** stroke brightness comes from audio (`glow`, `pop`, `energy`,
`momentum`) and from local density. Gesture weights may not feed it.

**Why:** gesture weight is highest exactly where particles are densest, and
brightness compounds with the bloom pass. The result is a hot white blob that
follows the cursor — nicknamed "лампочка" (the lightbulb) after the first time
it shipped.

Exception, and it is narrow: `cursorGlow` and `rippleGlow` in
`gesture.glowAt()`. Those light up *a particle that is already there* — they
never draw a shape of their own — and they are bounded and small.

**The rule was being broken by the loudest path in the renderer, for months.**
`createBloomLayer.flush` computed its send as `mouse.x / width`: the amount of
bloom over the entire frame, on every preset, was set by where the pointer
happened to be resting. Parked on the right it meant maximum bloom for a whole
song with nothing musical behind it; parked on the left, none. It also sat on
top of every layer's carefully budgeted alpha and flattened the contrast between
them. The reported symptom was "misplaced glow that never gets fixed", and it
never got fixed because the tuning was going into the layers underneath it.

**So:** when a brightness complaint survives several rounds of tuning, check the
*composite*, not the strokes. Search for `mouse` in anything that touches alpha,
and start at the shared code — a preset's own bug affects one preset.

---

## 3. Amount parameters need ceilings.

The beat shimmer took `c.pop` straight through as its blend amount. `pop` spikes
to ~1 on a hard beat, and at amount 1 the shimmer is a **full R/G/B channel
permutation** — not an iridescent tint but a complete colour swap, for a frame
or two, which reads as a glitch.

Capped at 0.4 inside `shimmerTint`. Fixing it in the shared function fixed all 7
presets at once; that is the point of §7.

**Generalise:** when a signal that can reach 1.0 is used as a blend/lerp amount,
ask what the effect *looks like at 1.0*. If the answer is "completely replaced",
it needs a ceiling.

### 3b. A ceiling must sit above the distribution, not through it.

A clamp is not a free safety net. Measured while building Layers: the melody
group's alpha had a 0.46 cap and a measured **p50 of 0.42** — more than half of
every frame's strokes were sitting on the ceiling. Everything that modulates that
alpha (the duck, `glow`, `harmonicShift`, local density) was being flattened out
of existence for those strokes. A layer that cannot get brighter also cannot
visibly get dimmer.

**So:** set a ceiling from the signal's real distribution, not from taste. It
belongs above p95, catching genuine peaks. If p50 is anywhere near the cap, the
cap has become the value and the dynamics are gone. This is measurable headlessly
in a few minutes — see §9.

### 3c. A clamp inside a *comparison* silently disables the comparison.

The same bug does far more damage when the clamped value is not drawn but
compared. A hit's power was `min(1, amplitude × 1.8)`. On a modern master every
segment above about −5 dB saturates, so through a whole chorus **every hit
measured exactly 1.0**. The star fires on a hit that beats the loudest of the
last few seconds — and nothing can beat a tie. Measured on twelve real tracks:
a star every **1.3 s** on the busiest, minimum gap 0.1 s. The mechanic that was
supposed to make the star rare was reporting `1 > 1` all song. The same ceiling
made 71–92 % of all hits qualify as the "middle rank".

Removing the clamp and measuring against the track's own 98th percentile
(`hitScale`) took it to 1–4 stars a minute with no other change.

**So:** anything feeding a `>` gets no clamp, and gets a per-track scale rather
than an absolute constant. A ceiling on a *drawn* value costs you dynamics; a
ceiling on a *compared* value costs you the whole feature, and it fails silently
— the code still runs, the event still fires, it just fires on everything.

---

## 4. Never re-blur accumulated history.

`createBloomLayer` blurs **only the current frame's fresh strokes**, then
composites. Blurring the persistent trail canvas and drawing it back onto itself
is unbounded positive feedback — solid white within seconds.

This is why every preset draws into `bloom.begin()`'s offscreen context rather
than straight to `ctx`.

---

### 4b. A multiplicative fade never reaches black.

Trails are made by compositing `rgba(0,0,0,a)` over the canvas each frame, which is
`c → c*(1-a)` rounded back to 8 bits. A pixel therefore stops moving the moment
`c*a < 0.5`. At the usual alpha of 0.045 that is **c = 11**, so every trail-based
preset settles on a permanent 11/255 (4.3%) grey background and stays there for as
long as it runs. It looks like light accumulating and it is not — it is rounding.

No amount of tuning the alpha fixes it; a smaller alpha raises the floor and a
larger one wrecks the trails. The step has to be one that strictly decreases.
`fadeTrail` adds a `color-burn` pass against `rgb(250,250,250)` — `1 - (1-dst)/src`
— which leaves bright pixels essentially untouched, collapses near-black to a true
zero in a few passes, and holds it at zero rather than oscillating around it.

**Two things this depends on.** The canvas must be opaque (`getContext("2d",
{ alpha: false })`): over a transparent backdrop a separable blend mode paints its
own source colour instead of blending, so the pass would flood the screen white
rather than darken it. And it runs every fourth frame, because on midtones the cost
is about 2% per pass and paying that every frame would visibly shorten the trails.

**Generalise:** whenever a value decays by repeated multiplication in fixed-point,
work out where it stalls. It is `0.5 / rate` for 8-bit rounding, and it is never
zero.

## 5. Smoothness is a hard requirement, not a polish pass.

Stated more times than any other piece of feedback in this project's history:
**ВСЁ ПЛАВНО.** Nothing may snap, jump, or pop.

Concretely:
- every scalar is eased, with the ease rate chosen per direction (attack ≠ decay)
- one-shot events set a *target*, never a value in use
- a value that must both grow and shrink uses **one** chase, never two competing
  clocks (see the ripple's `reach` — the earlier two-clock version fought itself
  and never opened far enough to be visible)
- a particle nearing an edge fades to zero *before* it respawns, so the teleport
  lands on something invisible
- rate-of-change caps beat blending when a direction must genuinely turn rather
  than cross-fade

### 5a. A signal shaped like an event must never set a speed.

`energy` reads like a level — "how loud is the music right now", 0..1, continuous.
It is not one. It is the loudness curve, and that curve is built **per segment**:
an attack to the segment's peak and a decay to the next one's start. Sampled at
60 fps over 89 dumps it **reverses direction 3.8 times a second**, and any one
second of it spans **2.1x** between its tenth and ninetieth percentile.

Every speed in the layers preset was wired to it. So the field accelerated and
braked three to five times a second, all song, in every passage. On Borderline at
0:08 the raw curve runs `0.16 -> 0.30 -> 0.19 -> 0.30 -> 0.51 -> 0.66 -> 0.17`
inside half a second and the percussion's median speed followed it exactly:
`56 -> 89 -> 68 -> 90 -> 134 -> 158 -> 63` px/s. Reported three times as the
sparks "racing" — and it survived two rounds of *lowering* them, because the
level was never the whole complaint. The jerk was.

**And the same edit fixed the "misplaced glow", which is not a coincidence.** A
stroke's contribution to the screen is `length x width x alpha`, and length is
speed. A speed spike IS a brightness spike, whatever the alpha says. Measured as
painted area per frame, its half-second swing was **1.9x** and dropped to **1.2x**
from this one change, with no brightness term touched. The user had said the two
went "hand in hand" before there was any measurement of either; they were one
event seen twice.

The fix is a follower, `Conductor.loudness`, ~0.6 s: slower than a segment,
faster than a phrase. It costs nothing — verse-to-chorus speed measures 1.68x
either way, because a follower keeps the mean and drops only the ripple.

**Found twice more in the same week, in the same curve.** `describeLeadIn` takes the
`lowest` and `highest` of the eight seconds before a drop and calls them the dip and
the build — of a sawtooth, so it was measuring ripple amplitude: `build` sat at its
ceiling for a third of all 348 moments. And `leadSeconds`, "how long since the level
last looked normal", is meaningless on a signal that crosses its own mean three times
a second — it returned the clamp minimum for half of them. Both now read a one-second
mean. Then a third instance, one layer up: `windup` floored its span at 3.5 s, which
*overrode* the measurement it was given for exactly those halved-out moments. **A
constant floor under a measured quantity throws the measurement away** — if the number
is trustworthy, use it; if it is not, fix the number.

So: **before wiring any signal to motion, sample it and count its reversals.**
If it turns more than about once a second it is an envelope, not a level. Send
it to brightness, width or spawn rate, where a step reads as a hit, and give
motion the smoothed form. A step in light is an event; a step in movement is a
fault.

### 5b. Align an object by its PEAK, not by its birth.

An eye reads an event at the moment of its maximum, not at its onset. Anything whose
response takes time to reach full strength must therefore be *started before* the
beat it belongs to, or its peak lands late by exactly its own attack time — and the
whole thing feels behind the music no matter how correct the trigger was.

Measured on the star: launching it on the hit put its peak **405 ms late**. Launching
it 400 ms early puts the peak **17 ms** from the hit. Nothing else changed.

This is possible because the analysis is a **timeline**, not a stream: the segments
after the playhead are already in memory with their loudness and their attack, so a
hit that has not happened yet is fully knowable. `Conductor.lookAhead(seconds)`
returns it. This is the first thing in the project that actually uses the property
ARCHITECTURE §1 has always claimed for it.

**And ask the right question of the future.** The first version of this gated on
`beatStrength`, which describes the *last* beat — useless when the whole point is to
act before the next one. `lookAhead` reports whether the *coming* hit lands on a bar
line instead. Anything reading a signal in order to act early must read the future
form of that signal, not the present one.

### 5c. Every event needs something before it.

Nothing may appear at full strength. The star's envelope originally had a decay and
**no attack** — it existed at full speed and full brightness in the first frame it
drew, which is an event with nothing before it, and it read as a foreign object
dropped onto the screen. Ranked particles switched their speed on at ignition. The
cut was computed straight from distance, so it was a light switch: on when a spark
entered range, off when it left.

All three are the same omission. A rise, however short, is what makes a thing arrive
rather than appear — and a fall slower than the rise is what makes it leave rather
than vanish.

## 6. Freeze on pause. Do not fade to black.

`if (!isPlaying) return;` before touching anything. `check-presets.js` asserts a
paused frame issues byte-identical canvas calls to the frame before it. Any state
advanced outside that guard breaks it.

---

## 7. Shared logic lives in one place.

If two presets need the same behaviour, it belongs in `flowfield-common.ts` or
`effects.ts` — not copy-pasted. Editing seven files to change one behaviour is
how the shimmer bug survived in all seven at once.

A preset should contain *only* its field math and its look. The distinguishing
character of a preset is legitimate (Flow Field's vector-share blend is kept on
purpose); identical plumbing is not.

Corollary: fix bugs at the shared function, not at the call site that reported
it. The lazy fix and the root-cause fix are the same fix.

---

## 8. Prefer real analysis data over invented heuristics.

Spotify's per-track analysis is rich and mostly unexploited. Before inventing a
heuristic, check whether `segments[]` already answers the question:

- `loudness_max_time` → attack character (percussive vs. swelling)
- `pitches[12]` → harmony, chord change, key
- `timbre[12]` → spectral character
- segment boundaries → a real timbral transition, ~0.2–0.4 s resolution, a
  faster reactive signal than beats

Same principle for whole visual designs: **port proven work, don't invent.**
Translate an actual algorithm rather than improvising an original one.

---

## 9. When reasoning stalls, record data.

Blind numeric tuning without visual access hits diminishing returns fast — it
did so four times on the same mechanic before the telemetry recorder was built.
Recording real sessions immediately surfaced two genuine bugs that reasoning had
missed.

**Procedure:** form a hypothesis → replay it offline against a real recording →
only then ship. `validate-gustcoherence.js` did exactly this and measured the
fix before it went in.

---

## 10. Verify headlessly before shipping.

```bash
npm run typecheck && npm run check
```

Both must be green before `npm run build && spicetify apply`. The check harness
exists because the thing cannot be watched while it is being written.

---

## 11. Layers couple through conditions, and only sometimes.

Written while building `flowfield-layers`, which runs three particle groups on
three musical layers. Both halves of this were arrived at from perception rather
than from tuning, and both are load-bearing.

**Common fate.** Things that move together are perceived as *one thing*. So
coupling three groups continuously and symmetrically does not enrich them — it
fuses them back into the single field the whole preset exists to escape. The
couplings must be occasional, asymmetric, and mostly subtractive.

**Each layer influences the others on the timescale it operates at musically.**
This is what keeps the couplings legible as separate effects instead of reading
as one shared multiplier:

| layer | musical role | how it influences |
|---|---|---|
| percussion | the clock | instantly, briefly (~0.35 s) |
| bass | the ground | continuously, slowly (frame of reference, ~20 s masking) |
| melody | the form | rarely, structurally (~2 s, on an actual chord change) |

**And the §1 rule applies between layers, not just between cursor and particle:**
a layer may change another layer's *conditions* — brightness, frame of reference,
spread, turn rate, which particles are eligible to light — and may never hand it a
direction or a point to aim at. Same failure mode, same fix.

**Corollary, from §3b:** prefer subtractive couplings. Three layers of *added*
light is a white blob under bloom. Ducking everything else around a hit reads as a
stronger accent than brightening the hit does, and it costs no headroom.

## 12. A signal that cannot move the picture is not a control.

Freeze one conductor signal at its own per-track mean, leave the other twenty-five
running, and measure what changes on screen. Run for every signal, this ranks the
whole design by authority — and the ranking was not what any of us thought.

Charlie's Inferno, first two minutes, change in painted area:

| frozen | change |
|---|---|
| `strike` | **75.1%** |
| `impact` — the entire drop mechanic | 6.6% |
| `sectionIntensity` — verse against chorus | 5.4% |
| `pop`, `windup`, `loudness`, `glow`, … | under 4% each |
| the remaining eighteen | under 2% each |

Borderline gives the same shape: `strike` 52%, nothing else above 5%.

**One signal painted three quarters of the screen and it was right 28% of the
time.** Everything else was, in the literal sense, inaudible: three consecutive
rounds of measured, verified fixes — to the drop's run-up, to the speed sawtooth,
to the lead-in measurement — produced no visible change *because each was a fix to
something worth two per cent.* The listener said "nothing changed" three times and
was right three times.

Two rules come out of this:

1. **Run the sweep before tuning anything.** A day spent perfecting a 2% signal is
   a day spent on nothing, and no amount of care in the measurement changes that.
2. **A channel with more than a handful of drivers has no drivers.** Sixteen terms
   multiply into a percussion spark's speed and eight into its alpha. Each was
   added for a real reason and each is individually defensible; together they
   guarantee that no single one can be seen, which is the same thing as saying the
   picture cannot be tuned at all. One channel, one driver — and a second only when
   the first is measurably audible without it.

## 13. Three channels carry the dynamics. They have to share.

The picture can say "louder" in three ways: more light, more motion, more marks. Read phrase
by phrase against the music (`node music-lab.js "<track>" --picture`), across six tracks:

| | correlation with the music | the picture's range | the music's range |
|---|---|---|---|
| light | 0.88 – 0.98 | ×4.7 – ×10.8 | ×2.6 – ×4.9 |
| motion | −0.12 – 0.37 (five of six) | ×1.3 – ×2.0 | |
| marks | 0.32 – 0.66 *(holding loudness still)* | ×2.1 – ×3.8 | |

Two things at once, and they are the same thing. **Motion said nothing** — the field moved at
the same speed in the quietest verse and the biggest chorus — and **light said everything
twice over**, exaggerating the song's own dynamic range by up to a factor of two, which is
why quiet passages went to almost nothing.

The exaggeration is compounding: alpha, line width, stroke length and the number of marks are
each a function of loudness, and they multiply. Four terms at ×1.4 is ×3.8.

How motion lost its share is worth keeping: it was flattened deliberately, to `0.8 + loudness
× 0.4`, while fixing the report that the sparks "race like mad". That complaint was about
*jitter* and about the *top speed*. Flattening the range fixed neither and cost the channel.

**So: when a channel has to come down, open its range downward — hold the top and drop the
quiet end — and check afterwards what the other channels are now doing on their own.** A
channel that measures under about ×1.5 across a whole song is not carrying anything, and
whatever it stopped carrying has silently been added to the others.

## 14. One population, one count. Every loop over it reads the same number.

`layers2` keeps a pool of sparks and draws the first `inSky` of them, where `inSky`
is a slow musical quantity. Three separate loops walked that pool — ignition, the
draw, and `cutters`, which is what a mark uses to light and comb the other two layers
— and one of them, `cutters`, walked all of it. So a spark could be lit inside the
sky, fall outside it as the count drifted (about **22 slots leave the pool a minute**
on real music), and then go on lighting and combing the field **from a fixed point,
forever**, while never being drawn — because a particle that is not drawn is not
aged either, so its envelope simply stopped. Measured on three real tracks: **17–46%
of frames carried at least one, up to four at once, 2.5–3.5% of all the cut weight.**

It is worth a rule of its own because of how it presents. There is no flicker and no
corner; the numbers all stay in range and `npm run check` is green. What you get is a
patch of the picture that is slightly brighter than it should be, in a place nothing
is happening, for as long as a minute — which is indistinguishable from a tuning
problem, and was chased as one.

**So:** a population's size is computed once, at the top of the frame, and every loop
that touches the population reads that one variable. And anything outside the drawn
set keeps running its own clock — a thing that stops being drawn has to go dark by
decaying, never by being forgotten, or it comes back mid-life the moment the boundary
moves again (§5c).

**Generalise:** whenever the same array is walked by two loops with different bounds,
the disagreement between those bounds is a live bug waiting for a slow variable to
move. Give it one name.
