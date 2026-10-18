# Archive

Nine presets. Eight were retired on 2026-09-17; `flowfield.ts` followed on 2026-09-20, the day
after it was rebuilt - see the note at the top of that file. The short version: the rebuild came out
as Aurora with one extra mechanic, and that mechanic measured at 26% of the light while reading as
nothing at all.

They all still compile — `npm run typecheck` covers this folder — so they cannot rot
silently, and any one of them comes back with a single import in `../index.ts`.

Why they left: none of them had been looked at in weeks, and an unmaintained preset is
not free. They carry the old gesture layer, `chaos`/`orderTotal`, `speedFader` and
`yAttraction` — signals the sensitivity sweep of DESIGN-RULES §12 measured at under 2%
of what reaches the screen — and eight copies of a mechanism is how the shimmer bug
survived in seven presets at once (§7). Keeping a few means those few get judged.

| file | what it was | worth keeping |
|---|---|---|
| `flowfield2.ts` | Flow Field with bounded `lerpAngle` bends instead of the vector-share blend | the bend chain, which the rebuilt Flow Field uses |
| `flowfield-curl.ts` | noise as a stream function — divergence-free, nothing ever clots | the curl trick. Worth a variant of Flow Field rather than a preset |
| `flowfield-ribbons.ts` | each ribbon keeps its own position history and redraws as one tapered polyline | connectivity as geometry rather than as fade timing |
| `flowfield-chroma.ts` | 12 pitch-class zones on a ring, each bending flow into an orbit | the idea is alive in the Plate plan, done properly |
| `flowfield-embers.ts` | layered fBm, soft round motes — reads density, not streamlines | the only one that was not a streamline picture |
| `flowfield-aurora.ts` | the anisotropic one: one sweep angle, bounded deviation in its rotated frame, long parallel sheets | the sheets, and the only preset wired to `telemetry.ts`. Flow Field's rebuild carried this look forward and was archived for being exactly that |
| `flowfield.ts` | Flow Field, rebuilt 2026-09-17 and archived 2026-09-20 | the band-of-light mechanic, as a warning: 26% of the picture's light, and unreadable |
| `flowfield-layers.ts` | the first three-group preset | frozen reference for Layers II. Its numbers are quoted all over the docs |
| `pulse.ts` | one hit, one expanding ring — the only non-field preset | the cleanest one-mapping preset here. A good starting point if a "simple" mode is ever wanted |

Two things to know before reviving one:

- They all still read `c.energy` in places where §5a says they may not — the per-segment
  sawtooth in a spread or an alpha. Only the speeds were fixed (2026-09-16).
- They read `c.chaos`/`c.order`/`c.gustStrength`/`c.yAttraction`/`c.speedFader`, which
  still exist on the Conductor and still work, but which the current design has replaced
  with `baton`/`hand`/`trailAt`/`rippleAt` (DESIGN-RULES §1d). Reviving one means
  deciding which of the two input models it is on.

## 2026-10-18: down to the two that ship

Retired for the release, not for failing: Layers 3D and Ridgeline are what goes out, and these
five stay here, compiling.

| file | what it was |
|---|---|
| `flowfield-layers2.ts` | Layers II - the flat picture everything since was derived from. Its rules are DESIGN-RULES |
| `layers3.ts` | Layers III - Layers II rewritten clean, plus stars, bloom, parallax camera and key hue |
| `smoke.ts` | Stable Fluids: the music as force in a room that remembers it |
| `plate.ts` | Chladni figures: the harmony as the shape sand settles into |
| `signal-scope.ts` | not a look - the instrument: every Conductor signal and the analysis's future, readable as numbers. Bring it back (one import) when a signal needs looking at |
