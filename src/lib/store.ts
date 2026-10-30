import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CATEGORY_MIN_DURATIONS,
  ProjectState,
} from "@/types/lachvid";

export const DATA_DIR = path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
export const STATE_FILE = path.join(DATA_DIR, "project_state.json");

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, OUTPUTS_DIR]) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function getInitialState(): ProjectState {
  return {
    sourceVideo: null,
    categoryMinDurations: { ...DEFAULT_CATEGORY_MIN_DURATIONS },
    shots: [],
    voiceTrack: null,
    syncMode: "video_master",
    diversityConfig: {
      targetCount: 8,
      targetOutputDuration: 20,
      minHammingDistance: 1,
      maxShotFrequency: 8,
      enableAutoVariantEdits: false,
      randomTransitionDuration: 0,
      seed: 2026,
    },
    composedVideos: [],
    zvidPlanLimits: null,
    zvidUploadUsage: null,
  };
}

export function readProjectState(): ProjectState {
  ensureDataDirs();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = getInitialState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectState>;
    const initial = getInitialState();
    return {
      ...initial,
      ...parsed,
      categoryMinDurations: {
        ...DEFAULT_CATEGORY_MIN_DURATIONS,
        ...(parsed.categoryMinDurations || {}),
      },
      diversityConfig: {
        ...initial.diversityConfig,
        ...(parsed.diversityConfig || {}),
        targetOutputDuration:
          parsed.diversityConfig?.targetOutputDuration &&
          parsed.diversityConfig.targetOutputDuration > 0
            ? parsed.diversityConfig.targetOutputDuration
            : 20,
      },
    };
  } catch {
    return getInitialState();
  }
}

export function writeProjectState(state: ProjectState): ProjectState {
  ensureDataDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  return state;
}
