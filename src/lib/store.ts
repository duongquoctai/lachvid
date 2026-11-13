import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_CATEGORY_MIN_DURATIONS,
  ProjectState,
} from "@/types/lachvid";

// Base temporary directory for multi-tenant sessions
export const BASE_SESSIONS_DIR = path.join(os.tmpdir(), "lachvid_sessions");

// Legacy support if needed
export const DATA_DIR = path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
export const STATE_FILE = path.join(DATA_DIR, "project_state.json");

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const envMaxStorageMb = Number(process.env.MAX_STORAGE_MB);
export const MAX_SESSIONS_BYTES =
  (Number.isFinite(envMaxStorageMb) && envMaxStorageMb > 0 ? envMaxStorageMb : 600) *
  1024 *
  1024; // Default 600 MB (configurable via MAX_STORAGE_MB)

export interface SessionPaths {
  rootDir: string;
  sourceDir: string;
  categoriesDir: string;
  voicesDir: string;
  stateFile: string;
}

export function sanitizeSessionId(sessionId?: string | null): string {
  if (!sessionId) return "default_session";
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "default_session";
}

export function getSessionPaths(sessionId: string): SessionPaths {
  const safeId = sanitizeSessionId(sessionId);
  const rootDir = path.join(BASE_SESSIONS_DIR, safeId);
  return {
    rootDir,
    sourceDir: path.join(rootDir, "source"),
    categoriesDir: path.join(rootDir, "categories"),
    voicesDir: path.join(rootDir, "voices"),
    stateFile: path.join(rootDir, "project_state.json"),
  };
}

export function ensureSessionDirs(sessionId: string): SessionPaths {
  const paths = getSessionPaths(sessionId);
  for (const d of [paths.rootDir, paths.sourceDir, paths.categoriesDir, paths.voicesDir]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
  return paths;
}

export function ensureDataDirs() {
  if (!fs.existsSync(BASE_SESSIONS_DIR)) {
    fs.mkdirSync(BASE_SESSIONS_DIR, { recursive: true });
  }
}

export function getInitialState(): ProjectState {
  return {
    sourceVideo: null,
    categoryMinDurations: { ...DEFAULT_CATEGORY_MIN_DURATIONS },
    shots: [],
    voiceTrack: null,
    categoryPools: {
      open: [],
      product: [],
      texture: [],
      apply: [],
      end: [],
    },
    multiVoiceTracks: [],
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

function getDirectorySize(dirPath: string): number {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else {
        const stat = fs.statSync(fullPath);
        size += stat.size;
      }
    } catch {
      // Ignore transient access errors
    }
  }
  return size;
}

export function cleanupExpiredSessions(
  maxAgeMs = SESSION_TTL_MS,
  maxTotalBytes = MAX_SESSIONS_BYTES
) {
  try {
    if (!fs.existsSync(BASE_SESSIONS_DIR)) return;
    const now = Date.now();
    const sessionEntries = fs.readdirSync(BASE_SESSIONS_DIR, { withFileTypes: true });

    const sessionStats: { dir: string; mtimeMs: number; sizeBytes: number }[] = [];
    let totalBytes = 0;

    for (const ent of sessionEntries) {
      if (!ent.isDirectory()) continue;
      const sessionPath = path.join(BASE_SESSIONS_DIR, ent.name);
      try {
        const stat = fs.statSync(sessionPath);
        const age = now - stat.mtimeMs;
        // Evict expired
        if (age > maxAgeMs) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          continue;
        }
        const sz = getDirectorySize(sessionPath);
        totalBytes += sz;
        sessionStats.push({ dir: sessionPath, mtimeMs: stat.mtimeMs, sizeBytes: sz });
      } catch {
        // Skip
      }
    }

    // Evict oldest if exceeding total bytes
    if (totalBytes > maxTotalBytes) {
      sessionStats.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      for (const s of sessionStats) {
        if (totalBytes <= maxTotalBytes) break;
        try {
          fs.rmSync(s.dir, { recursive: true, force: true });
          totalBytes -= s.sizeBytes;
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Graceful background cleanup error suppression
  }
}

export function touchSession(sessionId: string) {
  try {
    const paths = getSessionPaths(sessionId);
    if (fs.existsSync(paths.rootDir)) {
      const now = new Date();
      fs.utimesSync(paths.rootDir, now, now);
    }
  } catch {
    // Ignore utimes failure
  }
}

export function clearSessionSourceVideo(sessionId: string) {
  try {
    const paths = getSessionPaths(sessionId);
    if (fs.existsSync(paths.sourceDir)) {
      fs.rmSync(paths.sourceDir, { recursive: true, force: true });
      fs.mkdirSync(paths.sourceDir, { recursive: true });
    }
  } catch {
    // Ignore
  }
}

export function clearSessionCategories(sessionId: string) {
  try {
    const paths = getSessionPaths(sessionId);
    if (fs.existsSync(paths.categoriesDir)) {
      fs.rmSync(paths.categoriesDir, { recursive: true, force: true });
      fs.mkdirSync(paths.categoriesDir, { recursive: true });
    }
    if (fs.existsSync(paths.voicesDir)) {
      fs.rmSync(paths.voicesDir, { recursive: true, force: true });
      fs.mkdirSync(paths.voicesDir, { recursive: true });
    }
  } catch {
    // Ignore
  }
}

export function readProjectState(sessionId = "default_session"): ProjectState {
  const safeId = sanitizeSessionId(sessionId);
  const paths = ensureSessionDirs(safeId);
  touchSession(safeId);

  if (!fs.existsSync(paths.stateFile)) {
    const initial = getInitialState();
    fs.writeFileSync(paths.stateFile, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  try {
    const raw = fs.readFileSync(paths.stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectState>;
    const initial = getInitialState();

    // Verify if source video file still physically exists on disk
    if (parsed.sourceVideo?.localPath && !fs.existsSync(parsed.sourceVideo.localPath)) {
      parsed.sourceVideo = null;
      parsed.shots = [];
    }

    return {
      ...initial,
      ...parsed,
      categoryMinDurations: {
        ...DEFAULT_CATEGORY_MIN_DURATIONS,
        ...(parsed.categoryMinDurations || {}),
      },
      categoryPools: parsed.categoryPools || initial.categoryPools,
      multiVoiceTracks: parsed.multiVoiceTracks || [],
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

export function writeProjectState(
  state: ProjectState,
  sessionId = "default_session"
): ProjectState {
  const safeId = sanitizeSessionId(sessionId);
  const paths = ensureSessionDirs(safeId);
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2), "utf8");
  touchSession(safeId);
  return state;
}

export function getSessionIdFromHeaders(headers: Headers): string {
  const sid = headers.get("x-session-id") || headers.get("X-Session-Id");
  return sanitizeSessionId(sid);
}
