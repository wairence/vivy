import { layers3dPreset } from "./layers3d";
import { ridgePreset } from "./ridge";
import { PresetDefinition } from "./types";

// The presets that ship, in the order they are offered; the first is what a new user sees.
//   ridge      Ridgeline. The song as terrain coming at you: a row per sound, height its loudness.
//   layers3d   Drift, experimental: a volume of light ribbons the camera drifts through, a mark per
//              sound. (The id stays layers3d: saved choices and knobs are stored under it.)
export const PRESETS: PresetDefinition[] = [ridgePreset, layers3dPreset];

export type { Preset, PresetFrame, PresetDefinition } from "./types";
