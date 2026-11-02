export type ShotCategory = "open" | "product" | "texture" | "apply" | "end";

export type CategoryMinDurations = Record<ShotCategory, number>;

export const DEFAULT_CATEGORY_MIN_DURATIONS: CategoryMinDurations = {
  open: 5.8,
  product: 3.0,
  texture: 4.0,
  apply: 4.0,
  end: 4.0,
};

/**
 * Nếu thời lượng gốc của shot ngắn hơn số giây tối thiểu của Category,
 * tự động giảm speed (slow-motion) để kéo dài cho đủ số giây tối thiểu.
 * Nếu thời lượng gốc >= số giây tối thiểu, giữ nguyên 1 clip với speed = 1.
 */
export function computeShotSpeedForMinDuration(
  rawDuration: number,
  minDuration: number
): number {
  if (rawDuration <= 0.05 || minDuration <= 0.05) return 1;
  if (rawDuration >= minDuration) return 1;
  const calculated = rawDuration / minDuration;
  return Math.max(0.1, Math.round(calculated * 1000) / 1000);
}

export const SHOT_CATEGORIES: {
  id: ShotCategory;
  label: string;
  hotkey: string;
  color: string;
  badgeClass: string;
  description: string;
  defaultMinSeconds: number;
}[] = [
  {
    id: "open",
    label: "1. Open (Hook)",
    hotkey: "1",
    color: "#f43f5e",
    badgeClass: "bg-rose-500/20 text-rose-300 border-rose-500/40",
    description: "Mở đầu, cầm hộp, giới thiệu tên sản phẩm",
    defaultMinSeconds: 5.8,
  },
  {
    id: "product",
    label: "2. Product",
    hotkey: "2",
    color: "#3b82f6",
    badgeClass: "bg-blue-500/20 text-blue-300 border-blue-500/40",
    description: "Cận cảnh chai/lọ, bao bì sản phẩm",
    defaultMinSeconds: 3.0,
  },
  {
    id: "texture",
    label: "3. Texture",
    hotkey: "3",
    color: "#eab308",
    badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    description: "Chất kem trên tay, swatch chất sản phẩm",
    defaultMinSeconds: 4.0,
  },
  {
    id: "apply",
    label: "4. Apply / Use",
    hotkey: "4",
    color: "#10b981",
    badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    description: "Thoa lên mặt, quá trình sử dụng thực tế",
    defaultMinSeconds: 4.0,
  },
  {
    id: "end",
    label: "5. End (CTA)",
    hotkey: "5",
    color: "#a855f7",
    badgeClass: "bg-purple-500/20 text-purple-300 border-purple-500/40",
    description: "Kết quả trên da, cầm sản phẩm chốt đơn",
    defaultMinSeconds: 4.0,
  },
];

export interface ZvidCropParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZvidFilterOptions {
  brightness?: number; // -100 to 100
  contrast?: number; // -100 to 100
  saturate?: number; // -100 to 100
  "hue-rotate"?: string; // e.g., "10deg"
  blur?: number; // 0 to 100
  invert?: boolean | number; // 0..1
  colorTint?: string; // #rrggbb
}

export type ZvidXFadeEffect =
  | "fade"
  | "fadeblack"
  | "fadewhite"
  | "wipeleft"
  | "wiperight"
  | "slideleft"
  | "slideright"
  | "smoothleft"
  | "smoothright"
  | "circleopen"
  | "dissolve";

export interface ShotEdits {
  flipH: boolean;
  lockFlipH?: boolean; // Prevent random flipH if product text/logo must remain readable
  speed: number; // 0.1 to 10, default 1
  zoom: boolean | { depth: number }; // 1 to 10, e.g. 1.2
  cropParams?: ZvidCropParams;
  filter?: ZvidFilterOptions;
  transition?: ZvidXFadeEffect | null;
  transitionDuration?: number; // 0.3 to 1.5s
  customSrc?: string;
  customLocalUrl?: string;
  customLocalPath?: string;
}

export interface SourceVideo {
  id: string;
  name: string;
  fileName: string;
  localUrl: string;
  localPath: string;
  sizeBytes: number;
  duration: number;
  width: number;
  height: number;
  zvidUploadId?: string | null;
  zvidRemoteUrl?: string | null;
  zvidUploadedAt?: string | null;
  createdAt: string;
}

export interface Shot {
  id: string;
  sourceVideoId: string;
  label: string;
  begin: number; // seconds in source video
  end: number; // seconds in source video
  rawBegin?: number; // original detected start second in source video
  rawEnd?: number; // original detected end second in source video
  category: ShotCategory | null; // null while still an unclassified draft segment
  edits: ShotEdits;
}

export interface VoiceTrack {
  id: string;
  name: string;
  fileName: string;
  localUrl: string;
  localPath: string;
  sizeBytes: number;
  duration: number;
  zvidUploadId?: string | null;
  zvidRemoteUrl?: string | null;
  zvidUploadedAt?: string | null;
  createdAt: string;
}

export type AudioVideoSyncMode = "voice_master" | "video_master" | "shorter_wins";

export interface DiversityConfig {
  targetCount: number; // N videos to compose
  targetOutputDuration: number; // Target output duration per composed video in seconds (default 20s)
  minHammingDistance: number; // 1 to 5 (number of category slots that must differ between any pair)
  maxShotFrequency: number; // max times a single shot can appear across the batch
  enableAutoVariantEdits: boolean; // randomize slight zoom/filter/transition per composed video
  randomTransitionDuration: number; // e.g., 0.4s
  seed: number;
}

export interface ResolvedShotSlot {
  category: ShotCategory;
  shotId: string;
  shotLabel: string;
  sourceVideoId: string;
  videoBegin: number;
  videoEnd: number;
  src?: string;
  localUrl?: string;
  localPath?: string;
  originalVideoEnd?: number; // original shot end before trimming excess
  enterBegin: number;
  exitEnd: number;
  speed: number;
  flipH: boolean;
  zoom: boolean | { depth: number };
  cropParams?: ZvidCropParams;
  filter?: ZvidFilterOptions;
  transition?: ZvidXFadeEffect | null;
  transitionDuration?: number;
  transitionId?: string;
}

export interface ZvidVideoElement {
  type: "VIDEO";
  id: string;
  src: string;
  width: number;
  height: number;
  resize: "cover" | "contain";
  position: "center-center";
  videoBegin: number;
  videoEnd: number;
  enterBegin: number;
  exitEnd: number;
  volume: number;
  speed: number;
  flipH?: boolean;
  zoom?: boolean | { depth: number };
  cropParams?: ZvidCropParams;
  filter?: ZvidFilterOptions;
  transition?: ZvidXFadeEffect | null;
  transitionDuration?: number;
  transitionId?: string;
}

export interface ZvidAudioElement {
  src: string;
  enter: number;
  exit: number;
  audioBegin: number;
  audioEnd: number;
  volume: number;
  speed?: number;
  matchDuration?: boolean;
}

export interface ZvidRenderPayload {
  type?: "video";
  name: string;
  resolution: "custom";
  width: number;
  height: number;
  duration: number;
  durationMode: "fixed";
  frameRate: number;
  outputFormat: "mp4";
  backgroundColor: string;
  visuals: ZvidVideoElement[];
  audios?: ZvidAudioElement[];
}

export interface ComposedVideo {
  id: string;
  jobId: string; // Caller-supplied UUID for Zvid idempotency tracking
  name: string;
  tupleKey: string; // "shotOpenId|shotProductId|shotTextureId|shotApplyId|shotEndId"
  shotIds: [string, string, string, string, string];
  slots: ResolvedShotSlot[];
  totalVisualDuration: number;
  finalDuration: number;
  voiceTrackId?: string | null;
  syncMode: AudioVideoSyncMode;
  zvidPayload: ZvidRenderPayload;
  validation?: {
    valid: boolean;
    creditsRequired: number;
    warnings: unknown[];
    checkedAt: string;
    error?: string;
  } | null;
  renderState:
    | "draft"
    | "validating"
    | "validated"
    | "ValidationFailed"
    | "uploading"
    | "queued"
    | "active"
    | "completed"
    | "failed";
  progress: number;
  remoteResultUrl?: string | null;
  localOutputUrl?: string | null;
  outputExpiresAt?: string | null;
  failedReason?: string | null;
  creditsReserved?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryVideoItem {
  id: string;
  name: string;
  fileName: string;
  category: ShotCategory;
  localUrl: string;
  localPath?: string;
  duration: number;
  sizeBytes?: number;
  zvidUploadId?: string | null;
  zvidRemoteUrl?: string | null;
  isExternal?: boolean;
  lockFlipH?: boolean;
  driveFileId?: string;
  sourceType?: "drive" | "local";
}

export type CategoryPools = Record<ShotCategory, CategoryVideoItem[]>;

export interface MultiVoiceItem {
  id: string;
  name: string;
  fileName: string;
  localUrl: string;
  localPath?: string;
  duration: number;
}

export interface ProjectState {
  sourceVideo: SourceVideo | null;
  categoryMinDurations: CategoryMinDurations;
  shots: Shot[];
  voiceTrack: VoiceTrack | null;
  categoryPools?: CategoryPools;
  multiVoiceTracks?: MultiVoiceItem[];
  syncMode: AudioVideoSyncMode;
  diversityConfig: DiversityConfig;
  composedVideos: ComposedVideo[];
  zvidPlanLimits?: Record<string, unknown> | null;
  zvidUploadUsage?: {
    files: number;
    usedBytes: number;
    maxTotalBytes: number;
  } | null;
}

