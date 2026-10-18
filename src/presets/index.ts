import { layers3dPreset } from "./layers3d";
import { ridgePreset } from "./ridge";
import { PresetDefinition } from "./types";

// Two, as of 2026-10-18 - the two that ship. Everything else is in `archive/`, still compiling, one
// import away from coming back. A preset that is not being judged is not being maintained, and
// eight unmaintained ones is how a shared bug survived in all seven at once (DESIGN-RULES §7).
//
//   ridge      THE ONE. The song as terrain coming at you: a row per sound, height its loudness.
//   layers3d   "Drift", experimental: a volume of light ribbons the camera drifts through, a mark per
//              sound. (The id stays layers3d: saved choices and knobs are stored under it.)
// The first is what a new user sees.
export const PRESETS: PresetDefinition[] = [ridgePreset, layers3dPreset];

export type { Preset, PresetFrame, PresetDefinition } from "./types";
