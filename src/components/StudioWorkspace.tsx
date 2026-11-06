"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import JSZip from "jszip";
import {
  AudioVideoSyncMode,
  CategoryMinDurations,
  CategoryPools,
  CategoryVideoItem,
  ComposedVideo,
  computeShotSpeedForMinDuration,
  DEFAULT_CATEGORY_MIN_DURATIONS,
  MultiVoiceItem,
  ProjectState,
  RenderedVideoRecord,
  ResolvedShotSlot,
  Shot,
  ShotEdits,
  SHOT_CATEGORIES,
  ShotCategory,
  VoiceTrack,
} from "@/types/lachvid";
import { CATEGORY_ORDER, recalculateComposedVideo } from "@/lib/planner";
import PreviewPlayer916 from "@/components/PreviewPlayer916";
import IPhoneVideoTrimmer from "@/components/IPhoneVideoTrimmer";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Download,
  Edit3,
  Cloud,
  FileSpreadsheet,
  Film,
  FlipHorizontal,
  FolderDown,
  FolderOpen,
  FolderSync,
  History,
  Info,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  Lock,
  Mic,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Send,
  ShieldCheck,
  Shuffle,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Unlock,
  Upload,
  Wand2,
  X,
  ArrowUpDown,
  Check,
  Eye,
  Search,
  ExternalLink,
} from "lucide-react";
import * as XLSX from "xlsx";
import {
  parseExcelFiveColumnClipboard,
  extractGoogleDriveFileId,
} from "@/lib/drive";

const VALID_TABS = ["split", "mix", "history"] as const;
type WorkspaceTab = (typeof VALID_TABS)[number];

interface StudioWorkspaceProps {
  projectId: string;
  projectName?: string;
  initialTab?: string;
}

const createDefaultState = (): ProjectState => ({
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
    targetCount: 10,
    targetOutputDuration: 20,
    minHammingDistance: 2,
    maxShotFrequency: 5,
    enableAutoVariantEdits: false,
    randomTransitionDuration: 0,
    seed: 42,
  },
  composedVideos: [],
  zvidPlanLimits: null,
  zvidUploadUsage: null,
});

export default function StudioWorkspace({
  projectId,
  projectName,
  initialTab,
}: StudioWorkspaceProps) {
  const [currentProjectName, setCurrentProjectName] = useState<string>(
    projectName || "",
  );
  const [projectRenderedCount, setProjectRenderedCount] = useState<number>(0);
  const [renderedHistoryList, setRenderedHistoryList] = useState<RenderedVideoRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [mainTab, setMainTabState] = useState<WorkspaceTab>(() => {
    if (initialTab && (VALID_TABS as readonly string[]).includes(initialTab)) {
      return initialTab as WorkspaceTab;
    }
    if (typeof window !== "undefined") {
      const paramTab = new URLSearchParams(window.location.search).get("tab");
      if (paramTab && (VALID_TABS as readonly string[]).includes(paramTab)) {
        return paramTab as WorkspaceTab;
      }
    }
    return "split";
  });

  const setMainTab = useCallback((newTab: WorkspaceTab) => {
    setMainTabState(newTab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.get("tab") !== newTab) {
        url.searchParams.set("tab", newTab);
        window.history.replaceState(null, "", url.toString());
      }
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const paramTab = new URLSearchParams(window.location.search).get("tab");
      if (paramTab && (VALID_TABS as readonly string[]).includes(paramTab)) {
        setMainTabState(paramTab as WorkspaceTab);
      } else {
        setMainTabState("split");
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  const [historyFilterStatus, setHistoryFilterStatus] = useState<"all" | "unused" | "used">("all");
  const [historySearchText, setHistorySearchText] = useState<string>("");
  const [historySortOrder, setHistorySortOrder] = useState<"desc" | "asc">("desc");
  const [historyPage, setHistoryPage] = useState<number>(1);
  const [historyPageSize, setHistoryPageSize] = useState<number>(10);
  const [selectedHistoryDetail, setSelectedHistoryDetail] = useState<RenderedVideoRecord | null>(null);
  const [showExportMenu, setShowExportMenu] = useState<boolean>(false);
  const [state, setState] = useState<ProjectState>(() => createDefaultState());

  // Tab 1 (Split) states
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const slicerVideoRef = useRef<HTMLVideoElement | null>(null);
  const [slicerTime, setSlicerTime] = useState<number>(0);
  const [isPlayingSlicer, setIsPlayingSlicer] = useState<boolean>(false);
  const [playingShotOnly, setPlayingShotOnly] = useState<boolean>(false);
  const [pyThreshold, setPyThreshold] = useState<number>(27.0);
  const [pyMinSceneLen, setPyMinSceneLen] = useState<number>(0.8);
  const [pyDetector, setPyDetector] = useState<"content" | "adaptive">(
    "content",
  );
  const [isSlicing, setIsSlicing] = useState<boolean>(false);
  const [sourceBlobUrl, setSourceBlobUrl] = useState<string | null>(null);

  // Client-side session ID management (stored in localStorage)
  const [sessionId, setSessionId] = useState<string>(() => {
    if (typeof window !== "undefined") {
      let sid = localStorage.getItem("lachvid_session_id");
      if (!sid) {
        sid = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem("lachvid_session_id", sid);
      }
      return sid;
    }
    return "default_session";
  });
  const [splitEditingCategory, setSplitEditingCategory] =
    useState<ShotCategory | null>("open");
  const [accordionShotId, setAccordionShotId] = useState<string | null>(null);

  // Tab 2 (Mixer) states
  const [categoryPools, setCategoryPools] = useState<CategoryPools>({
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  });
  const [multiVoices, setMultiVoices] = useState<MultiVoiceItem[]>([]);
  const [selectedComposedId, setSelectedComposedId] = useState<string | null>(
    null,
  );
  const [targetMixDuration, setTargetMixDuration] = useState<number>(20);
  const [targetMixCount, setTargetMixCount] = useState<number>(10);
  const [mixVoiceMode, setMixVoiceMode] = useState<"none" | "rotate">("rotate");
  const [editingSlotCategory, setEditingSlotCategory] =
    useState<ShotCategory | null>(null);
  const [activeSlotFocusIndex, setActiveSlotFocusIndex] = useState<
    number | null
  >(null);
  const [previewSeekSec, setPreviewSeekSec] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<"full" | "slot">("full");
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [scrubSourceSec, setScrubSourceSec] = useState<number | null>(null);
  const [playTrigger, setPlayTrigger] = useState<number>(0);
  const [pauseTrigger, setPauseTrigger] = useState<number>(0);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState<boolean>(false);
  const [renderProgress, setRenderProgress] = useState<{
    current: number;
    total: number;
    name: string;
    percent: number;
  } | null>(null);
  const [isRenderingBatch, setIsRenderingBatch] = useState<boolean>(false);

  // Google Drive Ingest states
  const [excelPasteText, setExcelPasteText] = useState<string>("");
  const [isIngestingDrive, setIsIngestingDrive] = useState<boolean>(false);
  const [singleCategoryDriveModal, setSingleCategoryDriveModal] = useState<{
    category: ShotCategory | "voice";
    text: string;
  } | null>(null);
  const [showSecondaryUploadMode, setShowSecondaryUploadMode] =
    useState<boolean>(false);
  const [showClearConfirmModal, setShowClearConfirmModal] =
    useState<boolean>(false);
  const [isClearingAll, setIsClearingAll] = useState<boolean>(false);
  const [showClearHistoryConfirmModal, setShowClearHistoryConfirmModal] =
    useState<boolean>(false);
  const [isClearingHistory, setIsClearingHistory] = useState<boolean>(false);

  // Google Drive History & Search states
  const [showDriveHistoryDrawer, setShowDriveHistoryDrawer] = useState<boolean>(false);
  const [driveHistorySearchText, setDriveHistorySearchText] = useState<string>("");
  const [driveHistoryCategoryFilter, setDriveHistoryCategoryFilter] =
    useState<"all" | ShotCategory | "voice">("all");
  const [quickCheckInput, setQuickCheckInput] = useState<string>("");

  // Audition voice state
  const [auditionVoiceId, setAuditionVoiceId] = useState<string | null>(null);
  const auditionAudioRef = useRef<HTMLAudioElement | null>(null);

  const parsedExcel = useMemo(() => {
    return parseExcelFiveColumnClipboard(excelPasteText);
  }, [excelPasteText]);

  const allDriveLinks = useMemo(() => {
    const list: Array<{
      id: string;
      category: ShotCategory | "voice";
      name: string;
      fileName: string;
      fileId: string;
      driveUrl: string;
      duration: number;
      sizeBytes?: number;
    }> = [];

    CATEGORY_ORDER.forEach((cat) => {
      (categoryPools[cat] || []).forEach((it) => {
        if (it.driveFileId || it.sourceType === "drive") {
          const fileId =
            it.driveFileId || extractGoogleDriveFileId(it.localUrl) || "";
          list.push({
            id: it.id,
            category: cat,
            name: it.name,
            fileName: it.fileName,
            fileId,
            driveUrl: fileId
              ? `https://drive.google.com/file/d/${fileId}/view`
              : it.localUrl,
            duration: it.duration,
            sizeBytes: it.sizeBytes,
          });
        }
      });
    });

    (multiVoices || []).forEach((v) => {
      if (v.driveFileId || v.sourceType === "drive") {
        const fileId =
          v.driveFileId || extractGoogleDriveFileId(v.driveRawUrl || "") || "";
        list.push({
          id: v.id,
          category: "voice",
          name: v.name,
          fileName: v.fileName,
          fileId,
          driveUrl:
            v.driveRawUrl ||
            (fileId
              ? `https://drive.google.com/file/d/${fileId}/view`
              : v.localUrl),
          duration: v.duration,
        });
      }
    });

    return list;
  }, [categoryPools, multiVoices]);

  const quickCheckResult = useMemo(() => {
    const raw = quickCheckInput.trim();
    if (!raw) return null;
    const fileId = extractGoogleDriveFileId(raw);
    const searchLower = raw.toLowerCase();

    const matches = allDriveLinks.filter((item) => {
      if (fileId && item.fileId === fileId) return true;
      if (item.name.toLowerCase().includes(searchLower)) return true;
      if (item.fileName.toLowerCase().includes(searchLower)) return true;
      if (item.driveUrl.toLowerCase().includes(searchLower)) return true;
      return false;
    });

    return {
      query: raw,
      fileId,
      found: matches.length > 0,
      matches,
    };
  }, [quickCheckInput, allDriveLinks]);

  const filteredDriveLinks = useMemo(() => {
    let result = allDriveLinks;

    if (driveHistoryCategoryFilter !== "all") {
      result = result.filter(
        (it) => it.category === driveHistoryCategoryFilter,
      );
    }

    const q = driveHistorySearchText.trim().toLowerCase();
    if (q) {
      const qFileId = extractGoogleDriveFileId(q);
      result = result.filter((it) => {
        if (qFileId && it.fileId === qFileId) return true;
        if (it.name.toLowerCase().includes(q)) return true;
        if (it.fileName.toLowerCase().includes(q)) return true;
        if (it.driveUrl.toLowerCase().includes(q)) return true;
        if (it.fileId.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    return result;
  }, [allDriveLinks, driveHistoryCategoryFilter, driveHistorySearchText]);

  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<
    Array<{
      id: string;
      type: "info" | "success" | "error";
      text: string;
    }>
  >([]);

  const addToast = useCallback(
    (toast: { type: "info" | "success" | "error"; text: string } | null) => {
      if (!toast) return;
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, ...toast }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    [],
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Backwards-compatible alias so existing logic continues to work seamlessly
  const setStatusBanner = addToast;

  // Block F5 / reload / tab close when rendering batch
  useEffect(() => {
    if (!isRenderingBatch) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        "Quá trình kết xuất video đang diễn ra. Nếu rời khỏi trang, tiến trình sẽ bị hủy. Bạn có chắc muốn rời đi?";
      return e.returnValue;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "F5" ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")
      ) {
        e.preventDefault();
        setStatusBanner({
          type: "error",
          text: "Đang trong quá trình render video! Vui lòng không làm mới (F5) trang để tránh mất tiến trình.",
        });
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isRenderingBatch, setStatusBanner]);

  // Hidden file inputs
  const singleVideoInputRef = useRef<HTMLInputElement | null>(null);
  const masterFolderInputRef = useRef<HTMLInputElement | null>(null);
  const categoryInputRefs = useRef<
    Record<ShotCategory, HTMLInputElement | null>
  >({
    open: null,
    product: null,
    texture: null,
    apply: null,
    end: null,
  });
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  // Load project details (name, categoryPools, renderedCount, settings) for this projectId
  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/project/${projectId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.project?.name) {
          setCurrentProjectName(data.project.name);
        }
        if (data.categoryPools) {
          setCategoryPools(data.categoryPools);
        }
        if (data.voiceTracks) {
          setMultiVoices(data.voiceTracks);
        }
        if (data.project?.settings) {
          const s = data.project.settings;
          if (typeof s.targetMixDuration === "number") {
            setTargetMixDuration(s.targetMixDuration);
          }
          if (typeof s.targetMixCount === "number") {
            setTargetMixCount(s.targetMixCount);
          }
          if (s.mixVoiceMode === "none" || s.mixVoiceMode === "rotate") {
            setMixVoiceMode(s.mixVoiceMode);
          }
        }
        if (typeof data.renderedCount === "number") {
          setProjectRenderedCount(data.renderedCount);
        }
      })
      .catch(() => {});
  }, [projectId]);

  // Load project state and category library on mount or when sessionId is ready
  useEffect(() => {
    if (!sessionId) return;
    const sid = sessionId;

    fetch(`/api/project?sessionId=${encodeURIComponent(sid)}`, {
      headers: { "x-session-id": sid },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.state) {
          setState(data.state);
          if (data.state.shots?.length > 0) {
            setSelectedShotId(data.state.shots[0].id);
          }
          if (data.state.composedVideos?.length > 0) {
            setSelectedComposedId(data.state.composedVideos[0].id);
          }
          if (data.state.diversityConfig?.targetOutputDuration) {
            setTargetMixDuration(
              data.state.diversityConfig.targetOutputDuration,
            );
          }
        }
      })
      .catch(() => {});

    fetch(
      `/api/category-library?sessionId=${encodeURIComponent(sid)}&projectId=${encodeURIComponent(projectId)}`,
      {
        headers: { "x-session-id": sid },
      },
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.categoryPools) setCategoryPools(data.categoryPools);
        if (data.multiVoiceTracks) setMultiVoices(data.multiVoiceTracks);
      })
      .catch(() => {});
  }, [sessionId, projectId]);

  const persistState = useCallback(
    async (nextState: ProjectState) => {
      setState(nextState);
      try {
        await fetch("/api/project", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-session-id": sessionId,
          },
          body: JSON.stringify({ state: nextState, sessionId }),
        });

        // Đồng bộ lưu cấu hình cài đặt lên SQLite Cloud theo projectId
        if (projectId) {
          fetch(`/api/project/${projectId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              settings: {
                targetMixDuration,
                targetMixCount,
                mixVoiceMode,
                categoryMinDurations: nextState.categoryMinDurations,
              },
            }),
          }).catch(() => {});
        }
      } catch {
        // ignore transient save error
      }
    },
    [sessionId],
  );

  // Auto-detect and sync exact video duration from browser decoder for all category pool items
  const probedItemIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    for (const cat of CATEGORY_ORDER) {
      for (const item of categoryPools[cat] || []) {
        if (!item.localUrl || probedItemIdsRef.current.has(item.id)) continue;
        probedItemIdsRef.current.add(item.id);

        const v = document.createElement("video");
        v.preload = "metadata";
        v.src = item.localUrl;
        v.onloadedmetadata = () => {
          if (!active || !v.duration || isNaN(v.duration) || v.duration <= 0.1)
            return;
          const exactDur = Math.round(v.duration * 10) / 10;
          if (Math.abs(exactDur - item.duration) > 0.05) {
            setCategoryPools((prev) => {
              const currentList = prev[cat] || [];
              const updated = currentList.map((it) =>
                it.id === item.id ? { ...it, duration: exactDur } : it,
              );
              return { ...prev, [cat]: updated };
            });
          }
        };
      }
    }

    return () => {
      active = false;
    };
  }, [categoryPools]);

  // Auto-detect and sync exact voice duration from browser decoder for all multiVoice items
  const probedVoiceIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    for (const voice of multiVoices) {
      if (!voice.localUrl || probedVoiceIdsRef.current.has(voice.id)) continue;
      probedVoiceIdsRef.current.add(voice.id);

      const a = document.createElement("audio");
      a.preload = "metadata";
      a.src = voice.localUrl;
      a.onloadedmetadata = () => {
        if (!active || !a.duration || isNaN(a.duration) || a.duration <= 0.1)
          return;
        const exactDur = Math.round(a.duration * 10) / 10;
        if (Math.abs(exactDur - voice.duration) > 0.05) {
          setMultiVoices((prev) =>
            prev.map((v) =>
              v.id === voice.id ? { ...v, duration: exactDur } : v,
            ),
          );
        }
      };
    }
    return () => {
      active = false;
    };
  }, [multiVoices]);

  const handleToggleAuditionVoice = (v: MultiVoiceItem) => {
    if (auditionVoiceId === v.id && auditionAudioRef.current) {
      auditionAudioRef.current.pause();
      setAuditionVoiceId(null);
      return;
    }
    if (!auditionAudioRef.current) {
      auditionAudioRef.current = new Audio();
      auditionAudioRef.current.onended = () => setAuditionVoiceId(null);
    }
    auditionAudioRef.current.src = v.localUrl;
    auditionAudioRef.current.currentTime = 0;
    auditionAudioRef.current.play().catch(() => {});
    setAuditionVoiceId(v.id);
  };

  const categoryMinDurations: CategoryMinDurations = useMemo(() => {
    return {
      ...DEFAULT_CATEGORY_MIN_DURATIONS,
      ...(state?.categoryMinDurations || {}),
    };
  }, [state?.categoryMinDurations]);

  // Recalculate shot speed based on category min duration
  const applyMinDurationToShot = useCallback(
    (shot: Shot, minDurs: CategoryMinDurations): Shot => {
      if (!shot.category) return shot;
      const rawDur = Math.max(0.1, shot.end - shot.begin);
      const minDur =
        minDurs[shot.category] ?? DEFAULT_CATEGORY_MIN_DURATIONS[shot.category];
      const speed = computeShotSpeedForMinDuration(rawDur, minDur);
      return {
        ...shot,
        edits: {
          ...shot.edits,
          speed,
        },
      };
    },
    [],
  );

  const selectedShot = useMemo(() => {
    if (!state || !selectedShotId) return null;
    return state.shots.find((s) => s.id === selectedShotId) || null;
  }, [state, selectedShotId]);

  const splitCatShots = useMemo(() => {
    if (!state || !splitEditingCategory) return [];
    return state.shots.filter((s) => s.category === splitEditingCategory);
  }, [state, splitEditingCategory]);

  const accordionShot = useMemo(() => {
    if (!state || !accordionShotId) return null;
    return state.shots.find((s) => s.id === accordionShotId) || null;
  }, [state, accordionShotId]);

  const splitShotTrimInfo = useMemo(() => {
    if (!accordionShot) return null;
    const cat = accordionShot.category || "product";
    const baseStart = accordionShot.rawBegin ?? accordionShot.begin;
    const baseEnd = accordionShot.rawEnd ?? accordionShot.end;
    const rawDuration = Math.max(0.2, baseEnd - baseStart);
    const cutDur = Math.max(0.1, accordionShot.end - accordionShot.begin);
    const speed = accordionShot.edits.speed || 1.0;
    const effectiveDur = cutDur / speed;
    const minDur = categoryMinDurations[cat] ?? 3.0;
    return {
      baseStart,
      baseEnd,
      rawDuration,
      cutDur,
      speed,
      effectiveDur,
      minDur,
    };
  }, [accordionShot, categoryMinDurations]);

  const handleSelectSplitShot = (shot: Shot) => {
    setSelectedShotId(shot.id);
    if (slicerVideoRef.current) {
      slicerVideoRef.current.currentTime = shot.begin;
    }
    setSlicerTime(shot.begin);
  };

  const selectedComposed = useMemo(() => {
    if (!state || state.composedVideos.length === 0) return null;
    return (
      state.composedVideos.find((c) => c.id === selectedComposedId) ||
      state.composedVideos[0]
    );
  }, [state, selectedComposedId]);

  const selectedVoiceTrack: VoiceTrack | null = useMemo(() => {
    if (!selectedComposed?.voiceTrackId) return null;
    const found = multiVoices.find(
      (v) => v.id === selectedComposed.voiceTrackId,
    );
    if (found) {
      return {
        id: found.id,
        name: found.name,
        fileName: found.fileName,
        localUrl: found.localUrl,
        localPath: found.localPath || "",
        sizeBytes: 0,
        duration: found.duration || 20,
        createdAt: "",
      };
    }
    if (state?.voiceTrack?.id === selectedComposed.voiceTrackId) {
      return state.voiceTrack;
    }
    return null;
  }, [selectedComposed, multiVoices, state]);

  // Category counts
  const categoryStats = useMemo(() => {
    const counts: Record<ShotCategory, number> = {
      open: 0,
      product: 0,
      texture: 0,
      apply: 0,
      end: 0,
    };
    if (!state) return { counts, allFilled: false };
    for (const s of state.shots) {
      if (s.category && s.end > s.begin) {
        counts[s.category]++;
      }
    }
    const allFilled = CATEGORY_ORDER.every((c) => counts[c] >= 1);
    return { counts, allFilled };
  }, [state]);

  // ==========================================
  // TAB 1 ACTIONS (Tách 1 Video & Slicer Studio)
  // ==========================================

  const handleUploadSingleSource = async (file: File) => {
    if (!file) return;

    if (
      file.size > 95 * 1024 * 1024 &&
      typeof window !== "undefined" &&
      window.location.hostname.includes("trycloudflare.com")
    ) {
      setStatusBanner({
        type: "error",
        text: `File "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) vượt quá giới hạn 95 MB của Cloudflare Tunnel miễn phí. Hãy chọn video dưới 95 MB hoặc nén trước khi tải lên.`,
      });
      return;
    }

    setBusyMessage(`Đang tải lên video ${file.name}...`);
    setStatusBanner(null);
    try {
      let duration = 0;
      let width = 1080;
      let height = 1920;
      let localBlobUrl = "";
      try {
        const videoEl = document.createElement("video");
        videoEl.preload = "metadata";
        localBlobUrl = URL.createObjectURL(file);
        videoEl.src = localBlobUrl;
        await new Promise<void>((resolve) => {
          videoEl.onloadedmetadata = () => {
            duration = videoEl.duration || 0;
            width = videoEl.videoWidth || 1080;
            height = videoEl.videoHeight || 1920;
            resolve();
          };
          videoEl.onerror = () => {
            resolve();
          };
          setTimeout(resolve, 2000);
        });
      } catch {
        // fallback
      }

      setSourceBlobUrl(localBlobUrl);

      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "source");
      fd.append("sessionId", sessionId);
      if (duration > 0) fd.append("duration", String(duration));
      if (width > 0) fd.append("width", String(width));
      if (height > 0) fd.append("height", String(height));

      const res = await fetch("/api/upload-local", {
        method: "POST",
        headers: { "x-session-id": sessionId },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi tải video");

      setState(data.state);
      if (data.state.shots?.length > 0) {
        setSelectedShotId(data.state.shots[0].id);
      }
      setStatusBanner({
        type: "success",
        text: `Đã nạp video "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB). Hãy bấm Auto detect hoặc tách cảnh thủ công!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  const handleRunPySceneDetect = async () => {
    if (!state?.sourceVideo) {
      setStatusBanner({
        type: "error",
        text: "Vui lòng upload 1 video trước khi detect.",
      });
      return;
    }
    setBusyMessage(
      "Đang quét phân tích frame (PySceneDetect ContentDetector)...",
    );
    setStatusBanner(null);
    try {
      const res = await fetch("/api/detect-scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          sessionId,
          detector: pyDetector,
          threshold: pyThreshold,
          minSceneLen: pyMinSceneLen,
          categoryMinDurations,
        }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "Lỗi khi phân tích chuyển cảnh");

      setState(data.state);
      if (data.state.shots?.length > 0) {
        setSelectedShotId(data.state.shots[0].id);
        if (slicerVideoRef.current) {
          slicerVideoRef.current.currentTime = data.state.shots[0].begin;
          setSlicerTime(data.state.shots[0].begin);
        }
      }
      setStatusBanner({
        type: "success",
        text: `Auto detect thành công! Đã tách thành ${data.totalDetected} cảnh theo 5 category chuẩn. Bạn có thể tinh chỉnh số giây và xem trước từng cảnh!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  const handleCategoryChange = (shotId: string, newCat: ShotCategory) => {
    if (!state) return;
    const nextShots = state.shots.map((s) => {
      if (s.id !== shotId) return s;
      return applyMinDurationToShot(
        { ...s, category: newCat },
        categoryMinDurations,
      );
    });
    persistState({ ...state, shots: nextShots });
  };

  const handleDeleteShot = (shotId: string) => {
    if (!state) return;
    const nextShots = state.shots.filter((s) => s.id !== shotId);
    persistState({ ...state, shots: nextShots });
    if (selectedShotId === shotId) {
      setSelectedShotId(nextShots[0]?.id || null);
    }
  };

  // Play only active shot (begin -> end)
  const handlePlayActiveShot = (shot?: Shot | null) => {
    const targetShot = shot || selectedShot;
    if (!targetShot || !slicerVideoRef.current) return;

    slicerVideoRef.current.currentTime = targetShot.begin;
    slicerVideoRef.current.playbackRate = Math.min(
      4,
      Math.max(0.25, targetShot.edits.speed || 1),
    );
    slicerVideoRef.current.play().catch(() => {});
    setIsPlayingSlicer(true);
    setPlayingShotOnly(true);
  };

  const handleStopSlicer = () => {
    if (!slicerVideoRef.current) return;
    slicerVideoRef.current.pause();
    setIsPlayingSlicer(false);
    setPlayingShotOnly(false);
  };

  // Split shot at current playhead or midpoint
  const handleSplitAtTime = useCallback(
    (targetSec: number) => {
      if (!state) return;
      const shotToSplit =
        state.shots.find(
          (s) => targetSec > s.begin + 0.3 && targetSec < s.end - 0.3,
        ) || selectedShot;

      if (!shotToSplit) {
        setStatusBanner({
          type: "error",
          text: "Hãy chọn 1 shot hoặc di chuyển thanh thời gian vào giữa đoạn cần tách.",
        });
        return;
      }

      const cutPoint =
        targetSec > shotToSplit.begin + 0.2 && targetSec < shotToSplit.end - 0.2
          ? Math.round(targetSec * 10) / 10
          : Math.round(((shotToSplit.begin + shotToSplit.end) / 2) * 10) / 10;

      if (
        cutPoint <= shotToSplit.begin + 0.2 ||
        cutPoint >= shotToSplit.end - 0.2
      ) {
        return;
      }

      const firstHalf = applyMinDurationToShot(
        {
          ...shotToSplit,
          end: cutPoint,
          rawBegin: shotToSplit.rawBegin ?? shotToSplit.begin,
          rawEnd: cutPoint,
          label: `${shotToSplit.label} (P1)`,
        },
        categoryMinDurations,
      );
      const secondHalf = applyMinDurationToShot(
        {
          ...shotToSplit,
          id: `shot_${Date.now()}`,
          begin: cutPoint,
          end: shotToSplit.end,
          rawBegin: cutPoint,
          rawEnd: shotToSplit.rawEnd ?? shotToSplit.end,
          label: `${shotToSplit.label} (P2)`,
          edits: { ...shotToSplit.edits },
        },
        categoryMinDurations,
      );

      const nextShots: Shot[] = [];
      for (const s of state.shots) {
        if (s.id === shotToSplit.id) {
          nextShots.push(firstHalf, secondHalf);
        } else {
          nextShots.push(s);
        }
      }

      persistState({ ...state, shots: nextShots });
      setSelectedShotId(secondHalf.id);
      setStatusBanner({
        type: "success",
        text: `Đã tách đôi shot tại mốc ${cutPoint}s!`,
      });
    },
    [
      state,
      selectedShot,
      categoryMinDurations,
      applyMinDurationToShot,
      persistState,
      setStatusBanner,
    ],
  );

  // Merge shot with next shot
  const handleMergeWithNext = (shotId: string) => {
    if (!state) return;
    const idx = state.shots.findIndex((s) => s.id === shotId);
    if (idx === -1 || idx >= state.shots.length - 1) {
      setStatusBanner({
        type: "error",
        text: "Không có shot kế tiếp liền kề để gộp.",
      });
      return;
    }

    const currentShot = state.shots[idx];
    const nextShot = state.shots[idx + 1];

    const mergedShot = applyMinDurationToShot(
      {
        ...currentShot,
        end: nextShot.end,
        rawBegin: currentShot.rawBegin ?? currentShot.begin,
        rawEnd: nextShot.rawEnd ?? nextShot.end,
        label: `${currentShot.label} + ${nextShot.label}`,
      },
      categoryMinDurations,
    );

    const nextShots = state.shots.filter((_, i) => i !== idx && i !== idx + 1);
    nextShots.splice(idx, 0, mergedShot);

    persistState({ ...state, shots: nextShots });
    setSelectedShotId(mergedShot.id);
    setStatusBanner({
      type: "success",
      text: `Đã gộp thành công 2 cảnh liền kề thành cảnh mới dài ${(
        mergedShot.end - mergedShot.begin
      ).toFixed(1)}s!`,
    });
  };

  // Update shot begin and end (absolute timestamps in source video)
  const handleUpdateShotTrim = (
    shotId: string,
    newBegin: number,
    newEnd: number,
  ) => {
    if (!state) return;
    const maxDur = state.sourceVideo?.duration || 99999;
    const roundedBegin = Math.max(
      0,
      Math.min(maxDur - 0.2, Math.round(newBegin * 10) / 10),
    );
    const roundedEnd = Math.max(
      roundedBegin + 0.2,
      Math.min(maxDur, Math.round(newEnd * 10) / 10),
    );

    const nextShots = state.shots.map((s) => {
      if (s.id !== shotId) return s;
      return {
        ...s,
        rawBegin: s.rawBegin ?? s.begin,
        rawEnd: s.rawEnd ?? s.end,
        begin: roundedBegin,
        end: roundedEnd,
      };
    });
    persistState({ ...state, shots: nextShots });
  };

  const handleUpdateShotEdits = (shotId: string, edits: Partial<ShotEdits>) => {
    if (!state) return;
    const nextShots = state.shots.map((s) => {
      if (s.id !== shotId) return s;
      return {
        ...s,
        edits: {
          ...s.edits,
          ...edits,
        },
      };
    });
    persistState({ ...state, shots: nextShots });
  };

  // Direct begin/end editing with step 0.1s
  const handleUpdateShotTime = (
    shotId: string,
    field: "begin" | "end",
    val: number,
  ) => {
    if (!state) return;
    const rounded = Math.round(val * 10) / 10;
    const nextShots = state.shots.map((s) => {
      if (s.id !== shotId) return s;
      const updated = {
        ...s,
        [field]: rounded,
      };
      if (updated.end <= updated.begin + 0.2) {
        updated.end = Math.round((updated.begin + 0.3) * 10) / 10;
      }
      return applyMinDurationToShot(updated, categoryMinDurations);
    });
    persistState({ ...state, shots: nextShots });
  };

  // Per-shot inspector edits
  const handleToggleFlipH = (shotId: string) => {
    if (!state) return;
    const nextShots = state.shots.map((s) =>
      s.id === shotId
        ? { ...s, edits: { ...s.edits, flipH: !s.edits.flipH } }
        : s,
    );
    persistState({ ...state, shots: nextShots });
  };

  const handleToggleLockFlipH = (shotId: string) => {
    if (!state) return;
    const nextShots = state.shots.map((s) =>
      s.id === shotId
        ? { ...s, edits: { ...s.edits, lockFlipH: !s.edits.lockFlipH } }
        : s,
    );
    persistState({ ...state, shots: nextShots });
  };

  const handleSetSpeed = (shotId: string, speed: number) => {
    if (!state) return;
    const nextShots = state.shots.map((s) =>
      s.id === shotId ? { ...s, edits: { ...s.edits, speed } } : s,
    );
    persistState({ ...state, shots: nextShots });
  };

  const handleSetZoom = (shotId: string, depth: number | false) => {
    if (!state) return;
    const nextShots = state.shots.map((s) =>
      s.id === shotId
        ? {
            ...s,
            edits: {
              ...s.edits,
              zoom: depth ? { depth } : false,
            },
          }
        : s,
    );
    persistState({ ...state, shots: nextShots });
  };

  const keyActionsRef = useRef<{
    handleCategoryChange: (shotId: string, newCat: ShotCategory) => void;
    handleSplitAtTime: (targetSec: number) => void;
    handleToggleFlipH: (shotId: string) => void;
    handleToggleLockFlipH: (shotId: string) => void;
    handleStopSlicer: () => void;
    handlePlayActiveShot: (shot?: Shot | null) => void;
    selectedShotId: string | null;
    slicerTime: number;
    isPlayingSlicer: boolean;
  } | null>(null);

  useEffect(() => {
    keyActionsRef.current = {
      handleCategoryChange,
      handleSplitAtTime,
      handleToggleFlipH,
      handleToggleLockFlipH,
      handleStopSlicer,
      handlePlayActiveShot,
      selectedShotId,
      slicerTime,
      isPlayingSlicer,
    };
  });

  // Keyboard Shortcuts (1-5, S, M, L, Space)
  useEffect(() => {
    if (mainTab !== "split") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const actions = keyActionsRef.current;
      if (!actions) return;

      if (e.key >= "1" && e.key <= "5") {
        const catMap: Record<string, ShotCategory> = {
          "1": "open",
          "2": "product",
          "3": "texture",
          "4": "apply",
          "5": "end",
        };
        const targetCat = catMap[e.key];
        if (actions.selectedShotId && targetCat) {
          e.preventDefault();
          actions.handleCategoryChange(actions.selectedShotId, targetCat);
        }
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        actions.handleSplitAtTime(actions.slicerTime);
      } else if (e.key === "m" || e.key === "M") {
        if (actions.selectedShotId) {
          e.preventDefault();
          actions.handleToggleFlipH(actions.selectedShotId);
        }
      } else if (e.key === "l" || e.key === "L") {
        if (actions.selectedShotId) {
          e.preventDefault();
          actions.handleToggleLockFlipH(actions.selectedShotId);
        }
      } else if (e.key === " " && !e.repeat) {
        e.preventDefault();
        if (actions.isPlayingSlicer) {
          actions.handleStopSlicer();
        } else {
          actions.handlePlayActiveShot();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mainTab]);

  // Slice and download ZIP containing 5 category folders
  const handleSliceAndDownloadZip = async () => {
    if (!state?.sourceVideo || state.shots.length === 0) {
      setStatusBanner({ type: "error", text: "Chưa có cảnh nào để xuất." });
      return;
    }
    setIsSlicing(true);
    setBusyMessage(
      "Đang cắt video thành các file .mp4 riêng biệt và nén ZIP...",
    );
    try {
      const res = await fetch("/api/slice-scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          filePath: state.sourceVideo.localPath,
          scenes: state.shots,
          categoryMinDurations,
          sessionId,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `lachvid_categories_${sessionId}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setStatusBanner({
        type: "success",
        text: `Đã cắt thành công ${state.shots.length} clip và tải về file ZIP (chứa sẵn 5 folder OPEN, PRODUCT, TEXTURE, APPLY, END)!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setIsSlicing(false);
      setBusyMessage(null);
    }
  };

  // Direct save to folder on computer using File System Access API
  const handleDirectSaveToFolder = async () => {
    if (!state?.sourceVideo || state.shots.length === 0) {
      setStatusBanner({ type: "error", text: "Chưa có cảnh nào để xuất." });
      return;
    }

    if (!("showDirectoryPicker" in window)) {
      setStatusBanner({
        type: "info",
        text: "Trình duyệt của bạn chưa hỗ trợ chọn thư mục trực tiếp. Hệ thống sẽ tự động chuyển sang tải file .ZIP chia sẵn 5 folder!",
      });
      await handleSliceAndDownloadZip();
      return;
    }

    try {
      const picker = (
        window as unknown as {
          showDirectoryPicker?: (opts: unknown) => Promise<any>;
        }
      ).showDirectoryPicker;
      if (!picker) throw new Error("showDirectoryPicker không khả dụng");
      const rootDirHandle = await picker({ mode: "readwrite" });

      setIsSlicing(true);
      setBusyMessage("Đang cắt các clip và chuẩn bị ghi vào ổ cứng...");

      const res = await fetch("/api/slice-scenes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          filePath: state.sourceVideo.localPath,
          scenes: state.shots,
          categoryMinDurations,
          sessionId,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      setBusyMessage(
        "Đang ghi thẳng các file .mp4 vào đúng các thư mục trên máy tính...",
      );
      const zipBlob = await res.blob();
      const zip = await JSZip.loadAsync(zipBlob);

      let savedCount = 0;
      for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue;
        const parts = relativePath.split("/");
        const catName = parts[0]?.toUpperCase() || "PRODUCT";
        const fileName = parts[parts.length - 1];

        const catDirHandle = await rootDirHandle.getDirectoryHandle(catName, {
          create: true,
        });

        const fileBlob = await zipEntry.async("blob");
        const fileHandle = await catDirHandle.getFileHandle(fileName, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(fileBlob);
        await writable.close();
        savedCount++;
      }

      setStatusBanner({
        type: "success",
        text: `Tuyệt vời! Đã ghi thẳng ${savedCount} clip .mp4 vào đúng các folder OPEN, PRODUCT, TEXTURE, APPLY, END trên máy tính!`,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setIsSlicing(false);
      setBusyMessage(null);
    }
  };

  // Reset to process next video (up to 50 videos)
  const handleNextVideo = async () => {
    if (!state) return;
    try {
      await fetch("/api/project", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({ action: "reset_source", sessionId }),
      });
    } catch {
      // ignore
    }
    if (sourceBlobUrl) {
      URL.revokeObjectURL(sourceBlobUrl);
      setSourceBlobUrl(null);
    }
    persistState({
      ...state,
      sourceVideo: null,
      shots: [],
    });
    setSelectedShotId(null);
    setStatusBanner({
      type: "info",
      text: "Đã làm sạch không gian làm việc. Bạn hãy chọn video nguồn tiếp theo để tách cảnh!",
    });
  };

  // ==========================================
  // TAB 2 ACTIONS (Trộn theo folder category)
  // ==========================================

  // Mode chính: Nạp danh sách link Google Drive từ bảng 5 cột Excel
  const handleIngestExcelDriveLinks = async () => {
    if (parsedExcel.totalExtracted === 0) {
      setStatusBanner({
        type: "error",
        text: "Chưa tìm thấy link Google Drive hợp lệ nào trong bảng vừa dán.",
      });
      return;
    }

    setIsIngestingDrive(true);
    setBusyMessage(
      `Đang nạp và kiểm tra ${parsedExcel.totalExtracted} link Google Drive từ các cột...`,
    );
    setStatusBanner(null);

    try {
      const res = await fetch("/api/category-library", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          action: "ingest_drive_links",
          sessionId,
          projectId: projectId || undefined,
          categoryLinks: {
            open: parsedExcel.open,
            product: parsedExcel.product,
            texture: parsedExcel.texture,
            apply: parsedExcel.apply,
            end: parsedExcel.end,
            voice: parsedExcel.voice || [],
          },
        }),
      });

      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "Lỗi khi nạp link Google Drive");

      if (data.categoryPools) {
        setCategoryPools(data.categoryPools);
      }
      if (data.multiVoiceTracks) {
        setMultiVoices(data.multiVoiceTracks);
      }

      setExcelPasteText("");

      let resultMsg = `Đã nạp thành công ${data.addedCount} file từ Google Drive vào kho!`;
      if (data.duplicateCount > 0) {
        resultMsg += ` (Đã bỏ qua ${data.duplicateCount} file bị trùng)`;
      }
      if (data.errors && data.errors.length > 0) {
        resultMsg += ` — Lưu ý: Có ${data.errors.length} link chưa mở quyền công khai.`;
      }

      setStatusBanner({
        type: data.addedCount > 0 ? "success" : "info",
        text: resultMsg,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setIsIngestingDrive(false);
      setBusyMessage(null);
    }
  };

  // Nạp link Google Drive vào 1 cột category hoặc voice cụ thể
  const handleIngestSingleCategoryDrive = async (
    category: ShotCategory | "voice",
    text: string,
  ) => {
    const rawLinks = text
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const validFileIds = rawLinks
      .map((r) => extractGoogleDriveFileId(r))
      .filter((id): id is string => Boolean(id));

    if (validFileIds.length === 0) {
      setStatusBanner({
        type: "error",
        text: "Chưa tìm thấy link Google Drive hợp lệ nào.",
      });
      return;
    }

    const catLabel =
      category === "voice" ? "Voice (lồng tiếng)" : category.toUpperCase();
    setIsIngestingDrive(true);
    setBusyMessage(
      `Đang nạp ${validFileIds.length} link vào mục ${catLabel}...`,
    );
    setStatusBanner(null);

    try {
      const res = await fetch("/api/category-library", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          action: "ingest_drive_links",
          sessionId,
          projectId: projectId || undefined,
          targetCategory: category,
          links: validFileIds,
        }),
      });

      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "Lỗi khi nạp link Google Drive");

      if (data.categoryPools) {
        setCategoryPools(data.categoryPools);
      }
      if (data.multiVoiceTracks) {
        setMultiVoices(data.multiVoiceTracks);
      }
      setSingleCategoryDriveModal(null);

      let msg = `Đã nạp thành công ${data.addedCount} file vào mục ${catLabel}!`;
      if (data.duplicateCount > 0) {
        msg += ` (Đã bỏ qua ${data.duplicateCount} file bị trùng)`;
      }
      setStatusBanner({
        type: "success",
        text: msg,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setIsIngestingDrive(false);
      setBusyMessage(null);
    }
  };

  // Master folder upload (reads all subfolders OPEN, PRODUCT, TEXTURE, APPLY, END)
  const handleMasterFolderUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    let totalBytes = 0;
    for (let i = 0; i < files.length; i++) totalBytes += files[i].size;
    if (
      totalBytes > 95 * 1024 * 1024 &&
      typeof window !== "undefined" &&
      window.location.hostname.includes("trycloudflare.com")
    ) {
      setStatusBanner({
        type: "error",
        text: `Tổng dung lượng thư mục (${(totalBytes / 1024 / 1024).toFixed(1)} MB) vượt giới hạn 95 MB của Cloudflare Tunnel miễn phí. Hãy chia nhỏ hoặc nạp từng cột.`,
      });
      if (masterFolderInputRef.current) masterFolderInputRef.current.value = "";
      return;
    }

    setBusyMessage(`Đang phân loại và nạp ${files.length} file từ thư mục...`);
    setStatusBanner(null);
    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      if (projectId) fd.append("projectId", projectId);
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
      const res = await fetch("/api/category-library", {
        method: "POST",
        headers: { "x-session-id": sessionId },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi nạp thư mục");

      setCategoryPools(data.categoryPools);
      setStatusBanner({
        type: "success",
        text: `Đã nạp thành công ${data.addedCount} video vào 5 category!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
      if (masterFolderInputRef.current) masterFolderInputRef.current.value = "";
    }
  };

  // Upload into a single specific category column
  const handleCategoryColumnUpload = async (
    category: ShotCategory,
    files: FileList | null,
  ) => {
    if (!files || files.length === 0) return;

    let totalBytes = 0;
    for (let i = 0; i < files.length; i++) totalBytes += files[i].size;
    if (
      totalBytes > 95 * 1024 * 1024 &&
      typeof window !== "undefined" &&
      window.location.hostname.includes("trycloudflare.com")
    ) {
      setStatusBanner({
        type: "error",
        text: `Tổng dung lượng file (${(totalBytes / 1024 / 1024).toFixed(1)} MB) vượt giới hạn 95 MB của Cloudflare Tunnel miễn phí. Hãy tải từng file nhỏ hơn.`,
      });
      if (categoryInputRefs.current[category]) {
        categoryInputRefs.current[category]!.value = "";
      }
      return;
    }

    setBusyMessage(
      `Đang nạp ${files.length} video vào ${category.toUpperCase()}...`,
    );
    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      if (projectId) fd.append("projectId", projectId);
      fd.append("targetCategory", category);
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
      const res = await fetch("/api/category-library", {
        method: "POST",
        headers: { "x-session-id": sessionId },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi tải video");

      setCategoryPools(data.categoryPools);
      setStatusBanner({
        type: "success",
        text: `Đã thêm ${data.addedCount} video vào mục ${category.toUpperCase()}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
      if (categoryInputRefs.current[category]) {
        categoryInputRefs.current[category]!.value = "";
      }
    }
  };

  // Multi-voice tracks upload
  const handleVoiceUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusyMessage(`Đang nạp ${files.length} file audio voice...`);
    try {
      const fd = new FormData();
      fd.append("sessionId", sessionId);
      if (projectId) fd.append("projectId", projectId);
      fd.append("action", "upload_voice");
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
      const res = await fetch("/api/category-library", {
        method: "POST",
        headers: { "x-session-id": sessionId },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi tải audio");

      setMultiVoices(data.multiVoiceTracks);
      setStatusBanner({
        type: "success",
        text: `Đã nạp ${data.multiVoiceTracks.length} file lồng tiếng (Voiceovers).`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
      if (voiceInputRef.current) voiceInputRef.current.value = "";
    }
  };

  const handleRemoveCategoryItem = async (
    cat: ShotCategory,
    itemId: string,
  ) => {
    const fd = new FormData();
    fd.append("sessionId", sessionId);
    fd.append("action", "remove_item");
    fd.append("category", cat);
    fd.append("itemId", itemId);
    if (projectId) fd.append("projectId", projectId);
    const res = await fetch("/api/category-library", {
      method: "POST",
      headers: { "x-session-id": sessionId },
      body: fd,
    });
    const data = await res.json();
    if (data.categoryPools) setCategoryPools(data.categoryPools);
  };

  const handleRemoveVoiceItem = async (voiceId: string) => {
    if (auditionVoiceId === voiceId && auditionAudioRef.current) {
      auditionAudioRef.current.pause();
      setAuditionVoiceId(null);
    }
    const fd = new FormData();
    fd.append("sessionId", sessionId);
    fd.append("action", "remove_voice");
    fd.append("voiceId", voiceId);
    if (projectId) fd.append("projectId", projectId);
    const res = await fetch("/api/category-library", {
      method: "POST",
      headers: { "x-session-id": sessionId },
      body: fd,
    });
    const data = await res.json();
    if (data.multiVoiceTracks) setMultiVoices(data.multiVoiceTracks);
  };

  // Confirm and thoroughly clear all categories, voices, and combinations
  const handleConfirmClearAll = async () => {
    setIsClearingAll(true);
    try {
      const fd = new FormData();
      fd.append("action", "clear_all");
      fd.append("sessionId", sessionId);
      if (projectId) fd.append("projectId", projectId);
      const res = await fetch("/api/category-library", {
        method: "POST",
        headers: { "x-session-id": sessionId },
        body: fd,
      });
      const d = await res.json();
      if (d.categoryPools) setCategoryPools(d.categoryPools);
      setMultiVoices([]);
      setSelectedComposedId(null);
      setExcelPasteText("");
      setState((prev) => ({
        ...prev,
        categoryPools: d.categoryPools || {
          open: [],
          product: [],
          texture: [],
          apply: [],
          end: [],
        },
        multiVoiceTracks: [],
        composedVideos: [],
      }));
      setShowClearConfirmModal(false);
      setStatusBanner({
        type: "success",
        text: "Đã xóa trắng toàn bộ kho clip và các tổ hợp video.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setIsClearingAll(false);
    }
  };

  const fetchRenderedHistory = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingHistory(true);
    try {
      const res = await fetch(`/api/project?id=${encodeURIComponent(projectId)}&history=1`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.history)) {
          setRenderedHistoryList(data.history);
          setProjectRenderedCount(data.history.length);
        }
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingHistory(false);
    }
  }, [projectId]);

  useEffect(() => {
    let ignore = false;
    if (mainTab === "history" && projectId) {
      fetch(`/api/project?id=${encodeURIComponent(projectId)}&history=1`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!ignore && data?.history && Array.isArray(data.history)) {
            setRenderedHistoryList(data.history);
            setProjectRenderedCount(data.history.length);
          }
        })
        .catch(() => {});
    }
    return () => {
      ignore = true;
    };
  }, [mainTab, projectId]);

  const handleConfirmClearHistory = async () => {
    if (!projectId) return;
    setIsClearingHistory(true);
    try {
      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_history", projectId }),
      });
      if (res.ok) {
        setRenderedHistoryList([]);
        setProjectRenderedCount(0);
        setShowClearHistoryConfirmModal(false);
        addToast({
          type: "success",
          text: "Đã xóa toàn bộ lịch sử render của dự án.",
        });
      } else {
        const data = await res.json().catch(() => ({}));
        addToast({
          type: "error",
          text: data?.error || "Không thể xóa lịch sử render.",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    } finally {
      setIsClearingHistory(false);
    }
  };

  const handleDeleteHistoryItem = async (id?: string) => {
    if (!id) return;
    try {
      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_history_item", id }),
      });
      if (res.ok) {
        setRenderedHistoryList((prev) => prev.filter((r) => r.id !== id));
        if (selectedHistoryDetail?.id === id) {
          setSelectedHistoryDetail(null);
        }
        setProjectRenderedCount((prev) => Math.max(0, prev - 1));
        setStatusBanner({
          type: "success",
          text: "Đã xóa bản ghi video khỏi lịch sử render.",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    }
  };

  const handleToggleHistoryStatus = async (
    record: RenderedVideoRecord,
    e?: React.MouseEvent,
  ) => {
    if (e) e.stopPropagation();
    const newStatus: "unused" | "used" =
      record.status === "used" ? "unused" : "used";

    // Optimistic UI update
    setRenderedHistoryList((prev) =>
      prev.map((r) => (r.id === record.id ? { ...r, status: newStatus } : r)),
    );
    if (selectedHistoryDetail?.id === record.id) {
      setSelectedHistoryDetail((prev) =>
        prev ? { ...prev, status: newStatus } : null,
      );
    }

    try {
      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_render_status",
          id: record.id,
          status: newStatus,
        }),
      });
      if (!res.ok) {
        throw new Error("Không thể cập nhật trạng thái");
      }
      setStatusBanner({
        type: "success",
        text: `Đã đánh dấu "${record.name || "Video"}" là ${
          newStatus === "used" ? "đã sử dụng" : "chưa sử dụng"
        }.`,
      });
    } catch (err: unknown) {
      setRenderedHistoryList((prev) =>
        prev.map((r) =>
          r.id === record.id ? { ...r, status: record.status } : r,
        ),
      );
      if (selectedHistoryDetail?.id === record.id) {
        setSelectedHistoryDetail((prev) =>
          prev ? { ...prev, status: record.status } : null,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    }
  };

  const historyCounts = useMemo(() => {
    let unused = 0;
    let used = 0;
    for (const r of renderedHistoryList) {
      if (r.status === "used") used++;
      else unused++;
    }
    return { all: renderedHistoryList.length, unused, used };
  }, [renderedHistoryList]);

  const filteredHistoryList = useMemo(() => {
    let list = [...renderedHistoryList];

    if (historyFilterStatus === "unused") {
      list = list.filter((r) => r.status !== "used");
    } else if (historyFilterStatus === "used") {
      list = list.filter((r) => r.status === "used");
    }

    if (historySearchText.trim()) {
      const q = historySearchText.trim().toLowerCase();
      list = list.filter((r) => {
        const nameMatch = (r.name || "").toLowerCase().includes(q);
        const tupleMatch = (r.tupleKey || "").toLowerCase().includes(q);
        const comp = r.payload as ComposedVideo | undefined;
        const slotMatch = comp?.slots?.some((s) =>
          (s.shotLabel || s.shotId || "").toLowerCase().includes(q),
        );
        return nameMatch || tupleMatch || slotMatch;
      });
    }

    list.sort((a, b) => {
      const timeA = new Date(a.renderedAt).getTime() || 0;
      const timeB = new Date(b.renderedAt).getTime() || 0;
      return historySortOrder === "asc" ? timeA - timeB : timeB - timeA;
    });

    return list;
  }, [
    renderedHistoryList,
    historyFilterStatus,
    historySearchText,
    historySortOrder,
  ]);

  const totalHistoryPages = Math.max(
    1,
    Math.ceil(filteredHistoryList.length / historyPageSize),
  );

  const paginatedHistoryList = useMemo(() => {
    const start = (historyPage - 1) * historyPageSize;
    return filteredHistoryList.slice(start, start + historyPageSize);
  }, [filteredHistoryList, historyPage, historyPageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistoryPage(1);
  }, [
    historyFilterStatus,
    historySearchText,
    historySortOrder,
    historyPageSize,
  ]);

  const getGoogleDriveLinkFromSlot = (
    slot?: ResolvedShotSlot | null,
  ): string => {
    if (!slot) return "";
    if (slot.localUrl?.startsWith("/api/drive-stream/")) {
      const fileId = slot.localUrl
        .replace("/api/drive-stream/", "")
        .split("?")[0];
      if (fileId) return `https://drive.google.com/file/d/${fileId}/view`;
    }
    if (slot.shotId?.startsWith("drive_")) {
      const parts = slot.shotId.split("_");
      if (parts.length >= 3 && parts[2]) {
        return `https://drive.google.com/file/d/${parts[2]}/view`;
      }
    }
    if (
      slot.src &&
      (slot.src.includes("drive.google.com") ||
        slot.src.includes("googleusercontent.com"))
    ) {
      return slot.src;
    }
    return "";
  };

  const getGoogleDriveLinkFromVoice = (
    voice?: MultiVoiceItem | null,
  ): string => {
    if (!voice) return "";
    if (voice.driveRawUrl) return voice.driveRawUrl;
    if (voice.driveFileId) {
      return `https://drive.google.com/file/d/${voice.driveFileId}/view`;
    }
    if (voice.localUrl?.startsWith("/api/drive-stream/")) {
      const fileId = voice.localUrl
        .replace("/api/drive-stream/", "")
        .split("?")[0];
      if (fileId) return `https://drive.google.com/file/d/${fileId}/view`;
    }
    return "";
  };

  const handleExportHistory = (format: "xlsx" | "csv") => {
    setShowExportMenu(false);
    if (renderedHistoryList.length === 0) {
      setStatusBanner({
        type: "error",
        text: "Không có video nào trong lịch sử để xuất.",
      });
      return;
    }

    const rows = renderedHistoryList.map((rec, idx) => {
      const comp = rec.payload as ComposedVideo | undefined;
      const dateStr = rec.renderedAt
        ? new Date(rec.renderedAt).toLocaleString("vi-VN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          })
        : "";

      const slotMap: Record<string, string> = {
        open: "",
        product: "",
        texture: "",
        apply: "",
        end: "",
      };

      if (comp?.slots) {
        for (const slot of comp.slots) {
          const driveLink = getGoogleDriveLinkFromSlot(slot);
          slotMap[slot.category] =
            driveLink || slot.shotLabel || slot.shotId || "";
        }
      }

      let voiceValue = "";
      if (comp?.voiceTrackId) {
        const v = multiVoices.find((m) => m.id === comp.voiceTrackId);
        voiceValue = getGoogleDriveLinkFromVoice(v) || v?.name || "Voice";
      }

      return {
        STT: idx + 1,
        Name: rec.name || `Video #${idx + 1}`,
        Duration: comp?.finalDuration
          ? `${comp.finalDuration.toFixed(1)}s`
          : "",
        Date: dateStr,
        Open: slotMap.open,
        Product: slotMap.product,
        Texture: slotMap.texture,
        Apply: slotMap.apply,
        End: slotMap.end,
        Voice: voiceValue,
        Status: rec.status === "used" ? "Đã sử dụng" : "Chưa sử dụng",
      };
    });

    const projectNameSafe = (currentProjectName || "Lachvid").replace(
      /\s+/g,
      "_",
    );
    const fileName = `Lich_su_render_${projectNameSafe}_${new Date()
      .toISOString()
      .slice(0, 10)}`;

    if (format === "xlsx") {
      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet["!cols"] = [
        { wch: 6 }, // STT
        { wch: 25 }, // Name
        { wch: 12 }, // Duration
        { wch: 22 }, // Date
        { wch: 55 }, // Open
        { wch: 55 }, // Product
        { wch: 55 }, // Texture
        { wch: 55 }, // Apply
        { wch: 55 }, // End
        { wch: 55 }, // Voice
        { wch: 16 }, // Status
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Lịch sử render");
      XLSX.writeFile(workbook, `${fileName}.xlsx`);
    } else {
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const csvContent = XLSX.utils.sheet_to_csv(worksheet);
      const blob = new Blob(["\uFEFF" + csvContent], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    setStatusBanner({
      type: "success",
      text: `Đã xuất toàn bộ ${renderedHistoryList.length} video ra file ${format.toUpperCase()} thành công!`,
    });
  };

  const handlePreviewHistoryComposed = (rec: RenderedVideoRecord) => {
    if (!rec.payload) {
      setStatusBanner({
        type: "info",
        text: "Video này được render ở phiên bản cũ nên không có bản ghi chi tiết cảnh.",
      });
      return;
    }
    const comp = rec.payload as unknown as ComposedVideo;
    const exists = state.composedVideos.some((c) => c.id === comp.id);
    if (!exists) {
      setState((prev) => ({
        ...prev,
        composedVideos: [comp, ...prev.composedVideos],
      }));
    }
    setSelectedComposedId(comp.id);
    setMainTab("mix");
    setStatusBanner({
      type: "success",
      text: `Đang xem lại "${comp.name || rec.name || "Video đã render"}" trên màn hình preview 9:16.`,
    });
  };

  // Plan Combinatorial Mix
  const handlePlanDiverseMix = async () => {
    const missingCats = CATEGORY_ORDER.filter(
      (c) => (categoryPools[c]?.length || 0) === 0,
    );
    if (missingCats.length > 0) {
      setStatusBanner({
        type: "error",
        text: `Còn thiếu video ở các Category: ${missingCats.map((c) => c.toUpperCase()).join(", ")}. Hãy upload đủ 5 Category để bắt đầu trộn!`,
      });
      return;
    }

    setBusyMessage(
      "Đang tính toán các tổ hợp đa dạng tối ưu (Hamming distance, Speed Scale)...",
    );
    setStatusBanner(null);
    const clampedMixCount = Math.max(1, Math.min(50, targetMixCount || 10));

    try {
      const res = await fetch("/api/plan-mix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          sessionId,
          projectId: projectId || undefined,
          categoryPools,
          multiVoiceTracks: multiVoices,
          mixVoiceMode,
          diversityConfig: {
            targetCount: clampedMixCount,
            minHammingDistance: 2,
            maxShotFrequency: Math.max(2, Math.ceil(clampedMixCount / 3)),
            seed: Date.now(),
            enableAutoVariantEdits: false,
            randomTransitionDuration: 0,
          },
          preserveOriginalClips: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi tạo tổ hợp");

      setState((prev) => ({
        ...prev,
        composedVideos: data.composedVideos,
      }));
      if (data.composedVideos?.length > 0) {
        setSelectedComposedId(data.composedVideos[0].id);
        setEditingSlotCategory(null);
        setActiveSlotFocusIndex(0);
      }
      setStatusBanner({
        type: "success",
        text: `Đã tạo thành công ${data.totalComposed} tổ hợp video! Bạn có thể click vào từng cảnh (OPEN, PRODUCT...) để chỉnh tốc độ, cắt bớt giây và lật gương.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  // Inline scene slot editor within a composed video
  const handleUpdateComposedSlot = (
    composedId: string,
    slotIndex: number,
    edits: Partial<ResolvedShotSlot>,
  ) => {
    if (!state) return;
    const targetComp = state.composedVideos.find((c) => c.id === composedId);
    if (!targetComp) return;

    let currentVoice: VoiceTrack | null = null;
    if (targetComp.voiceTrackId) {
      const foundMulti = state.multiVoiceTracks?.find(
        (v) => v.id === targetComp.voiceTrackId,
      );
      if (foundMulti) {
        currentVoice = {
          id: foundMulti.id,
          name: foundMulti.name,
          fileName: foundMulti.fileName,
          localUrl: foundMulti.localUrl,
          localPath: foundMulti.localPath || "",
          sizeBytes: 0,
          duration: foundMulti.duration || 20,
          createdAt: "",
        };
      } else if (state.voiceTrack?.id === targetComp.voiceTrackId) {
        currentVoice = state.voiceTrack;
      }
    }

    const updatedComp = recalculateComposedVideo(
      targetComp,
      slotIndex,
      edits,
      currentVoice,
      state.syncMode,
    );

    const updatedList = state.composedVideos.map((c) =>
      c.id === composedId ? updatedComp : c,
    );

    persistState({
      ...state,
      composedVideos: updatedList,
    });
  };

  const handleChangeComposedVoice = (
    composedId: string,
    voiceId: string | null,
  ) => {
    if (!state) return;
    const targetComp = state.composedVideos.find((c) => c.id === composedId);
    if (!targetComp) return;

    let chosenVoice: VoiceTrack | null = null;
    if (voiceId) {
      const found = multiVoices.find((v) => v.id === voiceId);
      if (found) {
        chosenVoice = {
          id: found.id,
          name: found.name,
          fileName: found.fileName,
          localUrl: found.localUrl,
          localPath: found.localPath || "",
          sizeBytes: 0,
          duration: found.duration || 20,
          createdAt: "",
        };
      }
    }

    const updatedComp = recalculateComposedVideo(
      targetComp,
      -1,
      {},
      chosenVoice,
      state.syncMode,
    );
    updatedComp.voiceTrackId = voiceId;

    const updatedList = state.composedVideos.map((c) =>
      c.id === composedId ? updatedComp : c,
    );

    persistState({
      ...state,
      composedVideos: updatedList,
    });
  };

  // Direct FFmpeg Render Single Composed Video
  const handleRenderSingleComposed = async (composed: ComposedVideo) => {
    setBusyMessage(`Đang xuất file MP4 hoàn chỉnh cho ${composed.name}...`);
    try {
      const res = await fetch("/api/render-composed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          videos: [composed],
          multiVoiceTracks: multiVoices,
          sessionId,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${composed.name}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      // Ghi nhận lịch sử render vào dự án
      if (projectId) {
        fetch("/api/project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record_render",
            projectId,
            records: [
              {
                tupleKey: composed.tupleKey,
                name: composed.name,
                payload: composed,
              },
            ],
          }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.addedCount || res.count) {
              setProjectRenderedCount((prev) => prev + 1);
            }
          })
          .catch(() => {});
      }

      setStatusBanner({
        type: "success",
        text: `Đã xuất thành công ${composed.name}.mp4!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  // Direct FFmpeg Render All Composed Videos (ZIP download)
  const handleRenderAllComposedZip = async () => {
    if (!state?.composedVideos || state.composedVideos.length === 0) {
      setStatusBanner({ type: "error", text: "Chưa có tổ hợp nào để xuất." });
      return;
    }
    const totalCount = state.composedVideos.length;
    setIsRenderingBatch(true);
    setRenderProgress({
      current: 0,
      total: totalCount,
      name: "Đang khởi tạo FFmpeg...",
      percent: 0,
    });
    setBusyMessage(
      `Đang kết xuất ${totalCount} video MP4 và đóng gói ZIP...`,
    );

    let pollInterval: NodeJS.Timeout | null = null;
    try {
      pollInterval = setInterval(async () => {
        try {
          const pRes = await fetch(
            `/api/render-progress?sessionId=${encodeURIComponent(sessionId)}`,
          );
          if (pRes.ok) {
            const pData = await pRes.json();
            if (pData.active && pData.total > 0) {
              setRenderProgress({
                current: pData.current,
                total: pData.total,
                name: pData.current_name || "",
                percent: pData.percent,
              });
            }
          }
        } catch {
          // Ignore transient polling errors
        }
      }, 700);

      const res = await fetch("/api/render-composed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          videos: state.composedVideos,
          multiVoiceTracks: multiVoices,
          sessionId,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `lachvid_rendered_${sessionId}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      // Ghi nhận lịch sử render vào dự án khi tải ZIP thành công
      if (projectId) {
        const records = state.composedVideos.map((comp) => ({
          tupleKey: comp.tupleKey,
          name: comp.name,
          payload: comp,
        }));
        fetch("/api/project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record_render",
            projectId,
            records,
          }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.addedCount || res.count) {
              setProjectRenderedCount((prev) => prev + records.length);
            }
          })
          .catch(() => {});
      }

      setStatusBanner({
        type: "success",
        text: `Đã render thành công toàn bộ ${totalCount} video MP4 chuẩn và tải về ZIP!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      if (pollInterval) clearInterval(pollInterval);
      setRenderProgress(null);
      setIsRenderingBatch(false);
      setBusyMessage(null);
    }
  };





  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header & Two-Tab Navigation */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {/* Logo & Brand title */}
          <Link href="/" className="flex items-center gap-3 hover:opacity-90 transition">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-rose-500/20 shrink-0">
              <Film className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-extrabold tracking-tight">
                <span>Lachvid Studio</span>
              </h1>
              <p className="text-xs text-slate-400">
                Hệ thống tách video slicer & trộn lách content mỹ phẩm
              </p>
            </div>
          </Link>

          <div className="h-6 w-px bg-slate-800 mx-1 hidden sm:block" />

          {/* Button trở về Dự án & Tên Project */}
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-300 hover:text-white transition"
              title="Quay lại danh sách dự án"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Dự án</span>
            </Link>
            {/* Current Project Pill */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs">
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
              <span className="font-bold text-white">{currentProjectName || "Dự án"}</span>
              {projectRenderedCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMainTab("history");
                    fetchRenderedHistory();
                  }}
                  className="text-[11px] font-mono text-indigo-300 hover:text-white bg-indigo-950/60 hover:bg-indigo-900/80 px-2 py-0.5 rounded border border-indigo-800/60 transition flex items-center gap-1 cursor-pointer"
                  title="Bấm để xem lịch sử video đã render"
                >
                  <History className="w-3 h-3 text-indigo-400" />
                  <span>Đã render {projectRenderedCount} video</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 3 Dedicated Workspaces / Tabs */}
        <div className="flex items-center bg-slate-950 p-1.5 rounded-2xl border border-slate-800 shadow-inner gap-1">
          <button
            type="button"
            onClick={() => setMainTab("split")}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
              mainTab === "split"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/30 scale-100"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Scissors className="w-4 h-4" />
            <span>Tách video</span>
          </button>
          <button
            type="button"
            onClick={() => setMainTab("mix")}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
              mainTab === "mix"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/30 scale-100"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Shuffle className="w-4 h-4" />
            <span>Trộn ghép</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMainTab("history");
              fetchRenderedHistory();
            }}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
              mainTab === "history"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/30 scale-100"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <History className="w-4 h-4" />
            <span>Lịch sử render</span>
            {projectRenderedCount > 0 && (
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full font-bold transition-colors ${
                  mainTab === "history"
                    ? "bg-white/25 text-white"
                    : "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                }`}
              >
                {projectRenderedCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Hidden Master File Pickers */}
      <input
        ref={singleVideoInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) handleUploadSingleSource(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={masterFolderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleMasterFolderUpload}
      />
      {CATEGORY_ORDER.map((c) => (
        <input
          key={`col_input_${c}`}
          ref={(el) => {
            categoryInputRefs.current[c] = el;
          }}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          multiple
          className="hidden"
          onChange={(e) => handleCategoryColumnUpload(c, e.target.files)}
        />
      ))}
      <input
        ref={voiceInputRef}
        type="file"
        accept="audio/mp3,audio/wav,audio/m4a,audio/mpeg"
        multiple
        className="hidden"
        onChange={(e) => handleVoiceUpload(e.target.files)}
      />

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        {/* ======================================================== */}
        {/* TAB 1: TÁCH 1 VIDEO & SLICER STUDIO (CHỈNH GIÂY + PREVIEW) */}
        {/* ======================================================== */}
        {mainTab === "split" && (
          <div className="space-y-6">
            {/* Top Control Card: Upload 1 video & Min Giây */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 bg-slate-900/70 border border-slate-800 rounded-2xl p-5">
              {/* Left: Upload Single Video Source */}
              <div className="lg:col-span-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center justify-center text-xs">
                      1
                    </span>
                    <span>Upload 1 video gốc để tách</span>
                  </h2>
                  {state?.sourceVideo && (
                    <button
                      onClick={handleNextVideo}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Làm video mới</span>
                    </button>
                  )}
                </div>

                {!state?.sourceVideo ? (
                  <div
                    onClick={() => singleVideoInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer.files?.[0]) {
                        handleUploadSingleSource(e.dataTransfer.files[0]);
                      }
                    }}
                    className="border-2 border-dashed border-slate-700 hover:border-rose-500 rounded-2xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition bg-slate-950/40 hover:bg-slate-950/70"
                  >
                    <Upload className="w-7 h-7 text-rose-400 mb-2 animate-bounce" />
                    <p className="text-xs font-semibold text-white">
                      Chọn hoặc kéo thả 1 video gốc vào đây
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      MP4, MOV, WebM (Khuyên dùng video dọc 9:16)
                    </p>
                  </div>
                ) : (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold truncate text-white max-w-[200px]">
                        {state.sourceVideo.name}
                      </span>
                      <span className="font-mono text-emerald-400">
                        {state.sourceVideo.duration.toFixed(1)}s
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <div className="flex items-center gap-2">
                        <span>
                          {(state.sourceVideo.sizeBytes / 1024 / 1024).toFixed(
                            1,
                          )}{" "}
                          MB
                        </span>
                        <span>•</span>
                        <span>
                          {state.sourceVideo.width}x{state.sourceVideo.height}
                        </span>
                      </div>
                      <button
                        onClick={() => singleVideoInputRef.current?.click()}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-[11px] text-rose-300 transition"
                      >
                        <Upload className="w-3 h-3" />
                        <span>Đổi video khác</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Min Giây per Category & Auto Detect */}
              <div className="lg:col-span-7 space-y-3">
                <h2 className="text-sm font-bold flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 flex items-center justify-center text-xs">
                    2
                  </span>
                  <span>
                    Cài đặt số giây tối thiểu (min giây) cho 5 category
                  </span>
                </h2>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {SHOT_CATEGORIES.map((cat) => {
                    const currentMin = categoryMinDurations[cat.id];
                    return (
                      <div
                        key={cat.id}
                        className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex flex-col justify-between"
                      >
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border mb-1 self-start ${cat.badgeClass}`}
                        >
                          {cat.label}
                        </span>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            step="0.1"
                            min="1.0"
                            max="30.0"
                            value={currentMin}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 1.0;
                              const updatedMinDurs = {
                                ...categoryMinDurations,
                                [cat.id]: val,
                              };
                              if (state) {
                                const updatedShots = state.shots.map((s) =>
                                  applyMinDurationToShot(s, updatedMinDurs),
                                );
                                persistState({
                                  ...state,
                                  shots: updatedShots,
                                  categoryMinDurations: updatedMinDurs,
                                });
                              }
                            }}
                            className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-center text-white focus:outline-none focus:border-rose-500"
                          />
                          <span className="text-xs text-slate-400">s</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <label className="flex items-center gap-1">
                      <span>Thuật toán:</span>
                      <select
                        value={pyDetector}
                        onChange={(e) =>
                          setPyDetector(
                            e.target.value as "content" | "adaptive",
                          )
                        }
                        className="px-2 py-0.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200"
                      >
                        <option value="content">Content</option>
                        <option value="adaptive">Adaptive</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      <span>Threshold:</span>
                      <input
                        type="number"
                        value={pyThreshold}
                        onChange={(e) => setPyThreshold(Number(e.target.value))}
                        className="w-12 px-1 py-0.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-center text-slate-200"
                      />
                    </label>
                  </div>

                  <button
                    onClick={handleRunPySceneDetect}
                    disabled={!state?.sourceVideo}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold transition shadow-lg shadow-rose-500/20 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    <span>Auto detect cắt scene</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Category Statistics Summary Bar & Hotkeys Helper */}
            {state?.shots && state.shots.length > 0 && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                      <Layers className="w-4 h-4 text-rose-400" />
                      <span>Thống kê 5 nhóm cảnh cắt:</span>
                    </h3>
                    <div className="flex items-center gap-1.5">
                      {SHOT_CATEGORIES.map((c) => {
                        const cnt = categoryStats.counts[c.id];
                        return (
                          <span
                            key={c.id}
                            className={`px-2 py-0.5 rounded-md text-[11px] font-mono font-bold border ${
                              cnt > 0
                                ? c.badgeClass
                                : "bg-slate-950 text-slate-600 border-slate-800"
                            }`}
                          >
                            {c.id.slice(0, 3).toUpperCase()}: {cnt}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* Hotkeys helper pill */}
                  <div className="text-[11px] text-slate-400 flex items-center gap-2">
                    <span>Phím tắt:</span>
                    <span className="font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 text-slate-200">
                      1–5
                    </span>{" "}
                    gán Category •{" "}
                    <span className="font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 text-slate-200">
                      S
                    </span>{" "}
                    Tách đôi •{" "}
                    <span className="font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 text-slate-200">
                      M
                    </span>{" "}
                    Mirror •{" "}
                    <span className="font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 text-slate-200">
                      L
                    </span>{" "}
                    Khoá chữ •{" "}
                    <span className="font-mono bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 text-slate-200">
                      Space
                    </span>{" "}
                    Play/Dừng
                  </div>
                </div>
              </div>
            )}

            {/* FULL SLICER STUDIO WORKSPACE (GRID + 100% WIDTH EXPORT CARD) */}
            {state?.shots && state.shots.length > 0 && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  {/* ======================================================== */}
                  {/* LEFT COLUMN (7/12): 5 CATEGORY CARDS + INLINE INSPECTOR */}
                  {/* ======================================================== */}
                  <div className="lg:col-span-7 space-y-4">
                    {/* 5 Category Cards Header & Action */}
                    <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Layers className="w-4 h-4 text-indigo-400" />
                          <h3 className="text-sm font-bold text-white">
                            Kho video theo 5 category (đã tách từ video gốc)
                          </h3>
                        </div>
                        <button
                          onClick={() => {
                            const lastEnd =
                              state.shots[state.shots.length - 1]?.end || 0;
                            const maxDur = state.sourceVideo?.duration || 30;
                            const newBegin =
                              lastEnd < maxDur - 1
                                ? lastEnd
                                : Math.max(0, maxDur - 4);
                            const newEnd =
                              Math.round(Math.min(maxDur, newBegin + 4) * 10) /
                              10;
                            const catToAssign =
                              splitEditingCategory || "product";
                            const newShot: Shot = {
                              id: `shot_${Date.now()}`,
                              sourceVideoId: state.sourceVideo?.id || "src_vid",
                              label: `Cảnh #${state.shots.length + 1}`,
                              begin: Math.round(newBegin * 10) / 10,
                              end: newEnd,
                              rawBegin: Math.round(newBegin * 10) / 10,
                              rawEnd: newEnd,
                              category: catToAssign,
                              edits: {
                                flipH: false,
                                lockFlipH: false,
                                speed: 1,
                                zoom: false,
                              },
                            };
                            persistState({
                              ...state,
                              shots: [...state.shots, newShot],
                            });
                            handleSelectSplitShot(newShot);
                            setSplitEditingCategory(catToAssign);
                            setAccordionShotId(newShot.id);
                          }}
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 transition"
                        >
                          <Plus className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Thêm shot thủ công</span>
                        </button>
                      </div>

                      {/* 5 Slots Badges / Category Cards */}
                      <div className="grid grid-cols-5 gap-1.5">
                        {SHOT_CATEGORIES.map((cat) => {
                          const catShots = state.shots.filter(
                            (s) => s.category === cat.id,
                          );
                          const isCatActive = splitEditingCategory === cat.id;
                          const minDur = categoryMinDurations[cat.id] ?? 3.0;
                          const totalDur = catShots.reduce(
                            (acc, s) =>
                              acc + (s.end - s.begin) / (s.edits.speed || 1),
                            0,
                          );

                          return (
                            <button
                              key={cat.id}
                              type="button"
                              onClick={() => {
                                if (isCatActive) {
                                  setSplitEditingCategory(null);
                                  setAccordionShotId(null);
                                } else {
                                  setSplitEditingCategory(cat.id);
                                  setAccordionShotId(null);
                                  const currentCatShots = state.shots.filter(
                                    (s) => s.category === cat.id,
                                  );
                                  if (currentCatShots.length > 0) {
                                    handleSelectSplitShot(currentCatShots[0]);
                                  }
                                }
                              }}
                              className={`p-2 rounded-xl text-left border text-[10px] transition cursor-pointer flex flex-col justify-between ${
                                isCatActive
                                  ? "bg-indigo-950/70 border-indigo-500 ring-2 ring-indigo-500/50 shadow-md shadow-indigo-500/20"
                                  : "bg-slate-950/80 border-slate-800 hover:border-slate-700"
                              }`}
                            >
                              <div>
                                <div className="font-bold text-slate-200 uppercase flex items-center justify-between">
                                  <span
                                    className={
                                      isCatActive
                                        ? "text-indigo-300 font-extrabold"
                                        : ""
                                    }
                                  >
                                    {cat.id}
                                  </span>
                                  <span
                                    className={`font-mono font-bold ${isCatActive ? "text-indigo-300" : "text-slate-300"}`}
                                  >
                                    {catShots.length > 0
                                      ? `${totalDur.toFixed(1)}s`
                                      : "0s"}
                                  </span>
                                </div>
                                <div className="text-slate-400 truncate mt-1 text-[9px] font-medium">
                                  {catShots.length > 0
                                    ? `${catShots.length} cảnh`
                                    : "Chưa có"}
                                </div>
                              </div>
                              <div className="font-mono text-[9px] text-slate-500 mt-1.5 pt-1 border-t border-slate-800/80 flex items-center justify-between">
                                <span>≥ {minDur}s</span>
                                <span
                                  className={
                                    catShots.length > 0
                                      ? "text-emerald-400 font-bold"
                                      : "text-slate-600"
                                  }
                                >
                                  {catShots.length > 0 ? "✓ Sẵn sàng" : "Trống"}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Inline Scene Inspector / Accordion View */}
                      {splitEditingCategory && (
                        <div className="mt-3 p-3.5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 animate-in fade-in duration-200">
                          {splitCatShots.length === 0 ? (
                            /* EMPTY STATE */
                            <div className="py-6 text-center space-y-2">
                              <p className="text-xs text-slate-400">
                                Chưa có cảnh nào được gán cho nhóm{" "}
                                <span className="text-indigo-400 font-bold uppercase">
                                  {splitEditingCategory}
                                </span>
                                .
                              </p>
                              <button
                                type="button"
                                onClick={() => {
                                  const maxDur =
                                    state.sourceVideo?.duration || 30;
                                  const newShot: Shot = {
                                    id: `shot_${Date.now()}`,
                                    sourceVideoId:
                                      state.sourceVideo?.id || "src_vid",
                                    label: `Cảnh ${splitEditingCategory.toUpperCase()}`,
                                    begin: 0,
                                    end: Math.min(
                                      maxDur,
                                      categoryMinDurations[
                                        splitEditingCategory
                                      ] || 4,
                                    ),
                                    rawBegin: 0,
                                    rawEnd: Math.min(
                                      maxDur,
                                      categoryMinDurations[
                                        splitEditingCategory
                                      ] || 4,
                                    ),
                                    category: splitEditingCategory,
                                    edits: {
                                      flipH: false,
                                      lockFlipH: false,
                                      speed: 1,
                                      zoom: false,
                                    },
                                  };
                                  persistState({
                                    ...state,
                                    shots: [...state.shots, newShot],
                                  });
                                  handleSelectSplitShot(newShot);
                                  setAccordionShotId(newShot.id);
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20"
                              >
                                <Plus className="w-3.5 h-3.5" />
                                <span>
                                  + Tạo cảnh mới cho {splitEditingCategory}
                                </span>
                              </button>
                            </div>
                          ) : (
                            /* LIST OF SHOT CARDS WITH ACCORDIONS */
                            <div className="space-y-3">
                              {/* List Header Bar */}
                              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-bold text-indigo-300 uppercase px-2 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-500/30">
                                    Nhóm {splitEditingCategory}
                                  </span>
                                  <span className="text-xs text-slate-300 font-semibold">
                                    Danh sách {splitCatShots.length} cảnh
                                  </span>
                                </div>

                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const lastEnd =
                                        state.shots[state.shots.length - 1]
                                          ?.end || 0;
                                      const maxDur =
                                        state.sourceVideo?.duration || 30;
                                      const newBegin =
                                        lastEnd < maxDur - 1
                                          ? lastEnd
                                          : Math.max(0, maxDur - 4);
                                      const newEnd =
                                        Math.round(
                                          Math.min(maxDur, newBegin + 4) * 10,
                                        ) / 10;
                                      const newShot: Shot = {
                                        id: `shot_${Date.now()}`,
                                        sourceVideoId:
                                          state.sourceVideo?.id || "src_vid",
                                        label: `Cảnh ${splitEditingCategory.toUpperCase()} #${splitCatShots.length + 1}`,
                                        begin: Math.round(newBegin * 10) / 10,
                                        end: newEnd,
                                        rawBegin:
                                          Math.round(newBegin * 10) / 10,
                                        rawEnd: newEnd,
                                        category: splitEditingCategory,
                                        edits: {
                                          flipH: false,
                                          lockFlipH: false,
                                          speed: 1,
                                          zoom: false,
                                        },
                                      };
                                      persistState({
                                        ...state,
                                        shots: [...state.shots, newShot],
                                      });
                                      handleSelectSplitShot(newShot);
                                      setAccordionShotId(newShot.id);
                                    }}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold transition shadow-sm shadow-indigo-600/20"
                                  >
                                    <Plus className="w-3 h-3" />
                                    <span>Thêm cảnh</span>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSplitEditingCategory(null);
                                      setAccordionShotId(null);
                                    }}
                                    className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-300 hover:bg-indigo-500/20 border border-transparent hover:border-indigo-500/30 transition"
                                    title="Thu gọn bảng"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              {/* Scrollable list of cards */}
                              <div className="max-h-[550px] overflow-y-auto space-y-2.5 pr-1">
                                {splitCatShots.map((shot, sIdx) => {
                                  const isSelected = shot.id === selectedShotId;
                                  const isAccordionOpen =
                                    shot.id === accordionShotId;
                                  const rawDur = shot.end - shot.begin;
                                  const speed = shot.edits.speed || 1.0;
                                  const effectiveDur = (rawDur / speed).toFixed(
                                    1,
                                  );
                                  const minDur =
                                    categoryMinDurations[
                                      splitEditingCategory
                                    ] ?? 3.0;
                                  const isSlowMo = speed < 0.999;

                                  return (
                                    <div key={shot.id} className="space-y-2">
                                      {/* Shot Card Header / Row */}
                                      <div
                                        onClick={() => {
                                          handleSelectSplitShot(shot);
                                        }}
                                        className={`p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition select-none ${
                                          isSelected
                                            ? "bg-slate-900 border-indigo-500/80 shadow-md shadow-indigo-500/10 ring-1 ring-indigo-500/40"
                                            : "bg-slate-950/80 border-slate-800 hover:border-slate-700 hover:bg-slate-900/60"
                                        }`}
                                      >
                                        {/* Left: Index, Label, Timestamps, Badges */}
                                        <div className="flex items-center gap-3 min-w-0 flex-1">
                                          <span
                                            className={`w-6 h-6 rounded-lg border text-xs font-mono font-bold flex items-center justify-center shrink-0 ${
                                              isSelected
                                                ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/50"
                                                : "bg-slate-900 border-slate-700 text-slate-300"
                                            }`}
                                          >
                                            #{sIdx + 1}
                                          </span>
                                          <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                              <span className="text-xs font-bold text-white truncate">
                                                {shot.label}
                                              </span>
                                              {shot.edits.flipH && (
                                                <span className="px-1.5 py-0.2 rounded bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30 text-[9px] font-semibold">
                                                  Lật gương
                                                </span>
                                              )}
                                              {isSlowMo && (
                                                <span className="px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-[9px] font-mono">
                                                  {speed}x
                                                </span>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono mt-0.5">
                                              <span>
                                                {shot.begin.toFixed(1)}s →{" "}
                                                {shot.end.toFixed(1)}s
                                              </span>
                                              <span>•</span>
                                              <span
                                                className={`font-bold ${
                                                  parseFloat(effectiveDur) >=
                                                  minDur
                                                    ? "text-emerald-400"
                                                    : "text-amber-400"
                                                }`}
                                              >
                                                ⏱️ {effectiveDur}s
                                              </span>
                                            </div>
                                          </div>
                                        </div>

                                        {/* Right: Chỉnh sửa & Xoá buttons */}
                                        <div
                                          className="flex items-center gap-1.5 shrink-0"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <button
                                            type="button"
                                            onClick={() => {
                                              handleSelectSplitShot(shot);
                                              setAccordionShotId((prev) =>
                                                prev === shot.id
                                                  ? null
                                                  : shot.id,
                                              );
                                            }}
                                            className={`p-1.5 rounded-lg transition ${
                                              isAccordionOpen
                                                ? "text-indigo-300 bg-indigo-500/20 border border-indigo-500/40"
                                                : "text-slate-400 hover:text-indigo-300 hover:bg-slate-800"
                                            }`}
                                            title={
                                              isAccordionOpen
                                                ? "Đóng chỉnh sửa"
                                                : "Chỉnh sửa cảnh này"
                                            }
                                          >
                                            <Edit3 className="w-3.5 h-3.5" />
                                          </button>

                                          <button
                                            type="button"
                                            onClick={() => {
                                              handleDeleteShot(shot.id);
                                              if (accordionShotId === shot.id) {
                                                setAccordionShotId(null);
                                              }
                                            }}
                                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition"
                                            title="Xoá cảnh này"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </div>

                                      {/* Accordion Settings Panel */}
                                      {isAccordionOpen &&
                                        splitShotTrimInfo &&
                                        accordionShot &&
                                        accordionShot.id === shot.id && (
                                          <div className="pt-2 space-y-3 animate-in fade-in duration-200">
                                            {/* Header: Title, Mirror toggle, Play, Close X */}
                                            <div className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-2 gap-2">
                                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                                <span className="text-xs font-bold text-indigo-300 uppercase px-2 py-0.5 rounded-md bg-indigo-500/20 border border-indigo-500/30 shrink-0">
                                                  Cảnh {splitEditingCategory}
                                                </span>
                                                <input
                                                  type="text"
                                                  value={accordionShot.label}
                                                  onChange={(e) => {
                                                    const updated =
                                                      state.shots.map((s) =>
                                                        s.id ===
                                                        accordionShot.id
                                                          ? {
                                                              ...s,
                                                              label:
                                                                e.target.value,
                                                            }
                                                          : s,
                                                      );
                                                    persistState({
                                                      ...state,
                                                      shots: updated,
                                                    });
                                                  }}
                                                  className="bg-transparent text-xs font-bold text-slate-100 focus:outline-none border-b border-transparent focus:border-indigo-500 truncate flex-1 min-w-[120px]"
                                                  title="Click để đổi tên cảnh"
                                                />
                                                <span className="text-[10px] text-slate-400 font-mono hidden md:inline shrink-0">
                                                  (Gốc:{" "}
                                                  {splitShotTrimInfo.rawDuration.toFixed(
                                                    1,
                                                  )}
                                                  s)
                                                </span>
                                              </div>

                                              <div className="flex items-center gap-2 shrink-0">
                                                {/* Mirror toggle button */}
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    handleToggleFlipH(
                                                      accordionShot.id,
                                                    )
                                                  }
                                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold border transition ${
                                                    accordionShot.edits.flipH
                                                      ? "bg-indigo-600/30 text-indigo-300 border-indigo-500/60 shadow-sm"
                                                      : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
                                                  }`}
                                                  title="Lật gương ngang hình ảnh (Mirror)"
                                                >
                                                  <FlipHorizontal className="w-3.5 h-3.5" />
                                                  <span>
                                                    {accordionShot.edits.flipH
                                                      ? "Đang lật gương"
                                                      : "Lật gương"}
                                                  </span>
                                                </button>

                                                {/* Xem đoạn này button */}
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    handlePlayActiveShot(
                                                      accordionShot,
                                                    )
                                                  }
                                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-200 transition"
                                                  title="Phát thử đoạn video này trên player"
                                                >
                                                  <Play className="w-3 h-3 text-indigo-400 fill-current" />
                                                  <span>Xem đoạn này</span>
                                                </button>

                                                {/* Close Accordion Button */}
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    setAccordionShotId(null)
                                                  }
                                                  className="p-1 rounded-md text-slate-400 hover:text-indigo-300 hover:bg-indigo-500/20 transition"
                                                  title="Đóng bảng chỉnh sửa"
                                                >
                                                  <X className="w-3.5 h-3.5" />
                                                </button>
                                              </div>
                                            </div>

                                            {/* 3-Column Grid: Speed Controls (1 col) + Apple Trimmer (2 cols) */}
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                                              {/* Speed Controls */}
                                              <div className="space-y-1.5 p-2.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
                                                <div>
                                                  <label className="text-[11px] font-semibold text-slate-300 flex items-center justify-between mb-1.5">
                                                    <span>Tốc độ phát:</span>
                                                    <span className="text-indigo-400 font-mono font-bold">
                                                      {splitShotTrimInfo.speed}x
                                                    </span>
                                                  </label>
                                                  <div className="flex items-center gap-1 flex-wrap mb-2">
                                                    {[
                                                      0.5, 0.75, 1.0, 1.25, 1.5,
                                                      2.0,
                                                    ].map((spd) => (
                                                      <button
                                                        key={spd}
                                                        type="button"
                                                        onClick={() =>
                                                          handleUpdateShotEdits(
                                                            accordionShot.id,
                                                            {
                                                              speed: spd,
                                                            },
                                                          )
                                                        }
                                                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition ${
                                                          splitShotTrimInfo.speed ===
                                                          spd
                                                            ? "bg-indigo-600 text-white font-bold"
                                                            : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                                                        }`}
                                                      >
                                                        {spd}x
                                                      </button>
                                                    ))}
                                                  </div>
                                                  <input
                                                    type="range"
                                                    min="0.25"
                                                    max="3.0"
                                                    step="0.05"
                                                    value={
                                                      splitShotTrimInfo.speed
                                                    }
                                                    onChange={(e) =>
                                                      handleUpdateShotEdits(
                                                        accordionShot.id,
                                                        {
                                                          speed:
                                                            parseFloat(
                                                              e.target.value,
                                                            ) || 1.0,
                                                        },
                                                      )
                                                    }
                                                    className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                                                  />
                                                </div>
                                                <p className="text-[10px] text-slate-400 font-mono pt-1 border-t border-slate-800/80">
                                                  Cắt{" "}
                                                  {splitShotTrimInfo.cutDur.toFixed(
                                                    1,
                                                  )}
                                                  s ÷ {splitShotTrimInfo.speed}x
                                                  ={" "}
                                                  <span
                                                    className={`font-bold ${
                                                      splitShotTrimInfo.effectiveDur >=
                                                      splitShotTrimInfo.minDur
                                                        ? "text-emerald-400"
                                                        : "text-amber-400"
                                                    }`}
                                                  >
                                                    {splitShotTrimInfo.effectiveDur.toFixed(
                                                      1,
                                                    )}
                                                    s
                                                  </span>
                                                  {splitShotTrimInfo.effectiveDur <
                                                    splitShotTrimInfo.minDur && (
                                                    <span className="text-[9px] text-amber-400/90 ml-1">
                                                      (&lt;
                                                      {splitShotTrimInfo.minDur}
                                                      s tối thiểu)
                                                    </span>
                                                  )}
                                                </p>
                                              </div>

                                              {/* Apple Photos / iPhone Dual-Handle Video Trimmer (2 cols) */}
                                              <div className="sm:col-span-2">
                                                <IPhoneVideoTrimmer
                                                  videoBegin={
                                                    accordionShot.begin
                                                  }
                                                  videoEnd={accordionShot.end}
                                                  totalDuration={
                                                    state.sourceVideo
                                                      ?.duration ||
                                                    accordionShot.end ||
                                                    10
                                                  }
                                                  rawBegin={
                                                    accordionShot.rawBegin ??
                                                    accordionShot.begin
                                                  }
                                                  rawEnd={
                                                    accordionShot.rawEnd ??
                                                    accordionShot.end
                                                  }
                                                  onChange={(
                                                    newBegin,
                                                    newEnd,
                                                  ) =>
                                                    handleUpdateShotTrim(
                                                      accordionShot.id,
                                                      newBegin,
                                                      newEnd,
                                                    )
                                                  }
                                                  onScrubStart={() => {
                                                    handleStopSlicer();
                                                  }}
                                                  onScrubMove={(sourceSec) => {
                                                    const targetTime = Math.max(
                                                      0,
                                                      Math.min(
                                                        state.sourceVideo
                                                          ?.duration || 0,
                                                        sourceSec,
                                                      ),
                                                    );
                                                    if (
                                                      slicerVideoRef.current
                                                    ) {
                                                      slicerVideoRef.current.currentTime =
                                                        targetTime;
                                                    }
                                                    setSlicerTime(targetTime);
                                                  }}
                                                  onScrubEnd={() => {}}
                                                  onSeekPreview={(
                                                    targetSec,
                                                  ) => {
                                                    const targetTime = Math.max(
                                                      0,
                                                      Math.min(
                                                        state.sourceVideo
                                                          ?.duration || 0,
                                                        targetSec,
                                                      ),
                                                    );
                                                    if (
                                                      slicerVideoRef.current
                                                    ) {
                                                      slicerVideoRef.current.currentTime =
                                                        targetTime;
                                                    }
                                                    setSlicerTime(targetTime);
                                                  }}
                                                />
                                              </div>
                                            </div>

                                            {/* Advanced Options (Khoá chữ, Ken Burns, Gán Category, Xoá) - Mặc định mở luôn */}
                                            <div className="pt-2 border-t border-slate-800/80">
                                              <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 space-y-2.5">
                                                <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300">
                                                  <span className="flex items-center gap-1.5">
                                                    <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                                                    <span>
                                                      Tùy chọn nâng cao
                                                    </span>
                                                  </span>
                                                </div>

                                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                                                  {/* Lock flipH */}
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      handleToggleLockFlipH(
                                                        accordionShot.id,
                                                      )
                                                    }
                                                    className={`p-2 rounded-lg border flex items-center justify-between transition ${
                                                      accordionShot.edits
                                                        .lockFlipH
                                                        ? "bg-amber-500/20 border-amber-500/50 text-amber-200"
                                                        : "bg-slate-900 border-slate-800 text-slate-300"
                                                    }`}
                                                    title="Khoá không cho phép lật ngang nếu cảnh có chữ/tên thương hiệu"
                                                  >
                                                    <span className="flex items-center gap-1 font-medium text-[11px]">
                                                      {accordionShot.edits
                                                        .lockFlipH ? (
                                                        <Lock className="w-3.5 h-3.5 text-amber-400" />
                                                      ) : (
                                                        <Unlock className="w-3.5 h-3.5 text-slate-500" />
                                                      )}
                                                      Khoá chữ (L)
                                                    </span>
                                                    <span className="font-mono text-[10px] font-bold">
                                                      {accordionShot.edits
                                                        .lockFlipH
                                                        ? "LOCKED"
                                                        : "FREE"}
                                                    </span>
                                                  </button>

                                                  {/* Ken Burns Zoom */}
                                                  <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 flex flex-col justify-between">
                                                    <div className="flex items-center justify-between text-[10px] text-slate-400">
                                                      <span>
                                                        Ken Burns zoom
                                                      </span>
                                                      <span className="font-mono text-slate-200 font-bold">
                                                        {typeof accordionShot
                                                          .edits.zoom ===
                                                        "object"
                                                          ? `${accordionShot.edits.zoom.depth}x`
                                                          : accordionShot.edits
                                                                .zoom
                                                            ? "1.2x"
                                                            : "Tắt"}
                                                      </span>
                                                    </div>
                                                    <input
                                                      type="range"
                                                      min="1.0"
                                                      max="1.5"
                                                      step="0.05"
                                                      value={
                                                        typeof accordionShot
                                                          .edits.zoom ===
                                                        "object"
                                                          ? accordionShot.edits
                                                              .zoom.depth
                                                          : accordionShot.edits
                                                                .zoom
                                                            ? 1.2
                                                            : 1.0
                                                      }
                                                      onChange={(e) => {
                                                        const depth = Number(
                                                          e.target.value,
                                                        );
                                                        handleSetZoom(
                                                          accordionShot.id,
                                                          depth <= 1.01
                                                            ? false
                                                            : depth,
                                                        );
                                                      }}
                                                      className="w-full accent-indigo-500 h-1 bg-slate-800 rounded mt-1"
                                                    />
                                                  </div>

                                                  {/* Delete current shot */}
                                                  <div className="flex items-center justify-end">
                                                    <button
                                                      type="button"
                                                      onClick={() => {
                                                        handleDeleteShot(
                                                          accordionShot.id,
                                                        );
                                                        setAccordionShotId(
                                                          null,
                                                        );
                                                      }}
                                                      className="w-full py-2 px-3 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 transition"
                                                      title="Xoá cảnh này khỏi danh sách"
                                                    >
                                                      <Trash2 className="w-3.5 h-3.5" />
                                                      <span>Xoá cảnh này</span>
                                                    </button>
                                                  </div>
                                                </div>

                                                {/* Reassign Category buttons */}
                                                <div className="flex items-center gap-1.5 pt-1.5 border-t border-slate-800/80">
                                                  <span className="text-[10px] text-slate-400 shrink-0 font-medium">
                                                    Chuyển sang nhóm:
                                                  </span>
                                                  <div className="flex items-center gap-1 flex-wrap">
                                                    {SHOT_CATEGORIES.map(
                                                      (c) => (
                                                        <button
                                                          key={c.id}
                                                          type="button"
                                                          onClick={() => {
                                                            handleCategoryChange(
                                                              accordionShot.id,
                                                              c.id,
                                                            );
                                                            setSplitEditingCategory(
                                                              c.id,
                                                            );
                                                          }}
                                                          disabled={
                                                            accordionShot.category ===
                                                            c.id
                                                          }
                                                          className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition disabled:opacity-40 ${
                                                            accordionShot.category ===
                                                            c.id
                                                              ? c.badgeClass
                                                              : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                          }`}
                                                        >
                                                          {c.hotkey}.{" "}
                                                          {c.id.toUpperCase()}
                                                        </button>
                                                      ),
                                                    )}
                                                  </div>
                                                </div>
                                              </div>
                                            </div>
                                          </div>
                                        )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ======================================================== */}
                  {/* RIGHT COLUMN (5/12): VIDEO MONITOR 9:16 + TIMELINE RIBBON */}
                  {/* ======================================================== */}
                  <div className="lg:col-span-5 bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-4 flex flex-col justify-between">
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                          Màn hình duyệt cảnh (Source video monitor)
                        </h3>
                        <span className="text-xs font-mono text-indigo-400">
                          {slicerTime.toFixed(1)}s /{" "}
                          {(state.sourceVideo?.duration || 0).toFixed(1)}s
                        </span>
                      </div>

                      {/* 9:16 Video Canvas Player with live effects */}
                      <div className="relative aspect-[9/16] max-h-[380px] mx-auto rounded-xl overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center shadow-2xl">
                        {sourceBlobUrl || state.sourceVideo?.localUrl ? (
                          <video
                            ref={slicerVideoRef}
                            src={sourceBlobUrl || state.sourceVideo?.localUrl}
                            playsInline
                            onTimeUpdate={(e) => {
                              const cur = e.currentTarget.currentTime;
                              setSlicerTime(cur);

                              // If playing active shot only, stop or loop at shot.end
                              if (playingShotOnly && selectedShot) {
                                if (cur >= selectedShot.end) {
                                  e.currentTarget.pause();
                                  setIsPlayingSlicer(false);
                                  setPlayingShotOnly(false);
                                }
                              }
                            }}
                            onEnded={() => {
                              setIsPlayingSlicer(false);
                              setPlayingShotOnly(false);
                            }}
                            className="w-full h-full object-contain"
                            style={{
                              transform: selectedShot?.edits.flipH
                                ? "scaleX(-1)"
                                : undefined,
                            }}
                          />
                        ) : (
                          <div className="p-6 text-center text-xs text-slate-500">
                            Chưa nạp video
                          </div>
                        )}

                        {/* Active Shot Badge Overlay */}
                        {selectedShot && (
                          <div className="absolute top-2 left-2 z-10 px-2.5 py-0.5 rounded-full text-[10px] font-bold border bg-black/60 backdrop-blur-sm text-white border-white/20">
                            Đang chọn: {selectedShot.label} (
                            {selectedShot.category?.toUpperCase()})
                          </div>
                        )}
                      </div>

                      {/* Playback Controls Bar */}
                      <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800">
                        <div className="flex items-center gap-1.5">
                          {isPlayingSlicer ? (
                            <button
                              onClick={handleStopSlicer}
                              className="px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-bold flex items-center gap-1 hover:bg-amber-500/30"
                            >
                              <Pause className="w-3.5 h-3.5" />
                              <span>Tạm dừng</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => handlePlayActiveShot()}
                              className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-indigo-600/20"
                            >
                              <Play className="w-3.5 h-3.5" />
                              <span>Xem riêng</span>
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (slicerVideoRef.current && selectedShot) {
                                slicerVideoRef.current.currentTime =
                                  selectedShot.begin;
                                setSlicerTime(selectedShot.begin);
                              }
                            }}
                            className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300"
                            title="Về đầu cảnh"
                          >
                            Đầu cảnh
                          </button>
                          <button
                            onClick={() => {
                              if (slicerVideoRef.current && selectedShot) {
                                slicerVideoRef.current.currentTime =
                                  selectedShot.end;
                                setSlicerTime(selectedShot.end);
                              }
                            }}
                            className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300"
                            title="Về cuối cảnh"
                          >
                            Cuối cảnh
                          </button>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleSplitAtTime(slicerTime)}
                            className="px-2.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-semibold flex items-center gap-1"
                            title="Tách đôi shot tại con trỏ (phím S)"
                          >
                            <Scissors className="w-3 h-3" />
                            <span>Tách (S)</span>
                          </button>
                          {selectedShotId && (
                            <button
                              onClick={() =>
                                handleMergeWithNext(selectedShotId)
                              }
                              className="px-2.5 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold"
                              title="Gộp với shot kế tiếp"
                            >
                              Gộp sau
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Interactive Timeline Ribbon */}
                    <div className="space-y-1.5 pt-3 border-t border-slate-800/80">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>
                          Thanh timeline phân đoạn (Click để chọn cảnh)
                        </span>
                        <span className="font-mono text-emerald-400">
                          {state.shots.length} shots
                        </span>
                      </div>

                      <div className="h-9 w-full rounded-xl bg-slate-950 border border-slate-800 overflow-hidden flex p-0.5 gap-0.5">
                        {state.shots.map((shot) => {
                          const totalDur = state.sourceVideo?.duration || 1;
                          const widthPct = Math.max(
                            2,
                            ((shot.end - shot.begin) / totalDur) * 100,
                          );
                          const catObj = SHOT_CATEGORIES.find(
                            (c) => c.id === shot.category,
                          );
                          const isSel = shot.id === selectedShotId;
                          return (
                            <button
                              key={shot.id}
                              onClick={() => {
                                setSelectedShotId(shot.id);
                                if (shot.category) {
                                  setSplitEditingCategory(shot.category);
                                  setAccordionShotId(shot.id);
                                }
                                if (slicerVideoRef.current) {
                                  slicerVideoRef.current.currentTime =
                                    shot.begin;
                                }
                                setSlicerTime(shot.begin);
                              }}
                              style={{
                                width: `${widthPct}%`,
                                backgroundColor: catObj
                                  ? `${catObj.color}33`
                                  : "#334155",
                                borderColor: isSel
                                  ? "#ffffff"
                                  : catObj?.color || "#475569",
                              }}
                              className={`h-full rounded-md border text-[10px] font-mono truncate px-1 flex items-center justify-center transition ${
                                isSel
                                  ? "ring-2 ring-white z-10 font-bold"
                                  : "opacity-80 hover:opacity-100"
                              }`}
                              title={`${shot.label} (${shot.begin.toFixed(1)}s - ${shot.end.toFixed(1)}s)`}
                            >
                              {shot.category
                                ? shot.category.slice(0, 3).toUpperCase()
                                : "?"}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 100% WIDTH EXPORT ACTION BAR CARD */}
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Xuất toàn bộ các cảnh đã tinh chỉnh về máy tính
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Cắt siêu tốc bằng FFmpeg, giữ nguyên chất lượng 100%,
                        bảo toàn mốc giây và mirror đã chỉnh
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={handleSliceAndDownloadZip}
                        disabled={isSlicing}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 transition disabled:opacity-50"
                      >
                        <Download className="w-4 h-4 text-rose-400" />
                        <span>Tải ZIP toàn bộ (5 folder)</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDirectSaveToFolder}
                        disabled={isSlicing}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg shadow-emerald-600/20 disabled:opacity-50"
                      >
                        <FolderDown className="w-4 h-4" />
                        <span>Lưu thẳng vào thư mục máy tính</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleNextVideo}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/20"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Tách video tiếp theo</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 2: TRỘN & GHÉP TỔ HỢP TỪ FOLDER CATEGORY (MIXER 20S) */}
        {/* ======================================================== */}
        {mainTab === "mix" && (
          <div className="space-y-6">
            {/* Top Action Bar: Mode chính (Excel Google Drive) & Mode phụ (Upload máy) */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold flex items-center gap-2 text-white">
                    <Cloud className="w-5 h-5 text-sky-400 shrink-0" />
                    <span>
                      Kho video theo 5 category (Google Drive & máy tính)
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Mode chính: Dán bảng 5 cột từ Excel (Google Drive) với cơ
                    chế zero-disk stream. Mode phụ: Tải trực tiếp thư mục từ máy
                    tính.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 sm:ml-auto">
                  <button
                    type="button"
                    onClick={() => setShowDriveHistoryDrawer(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-950/80 hover:bg-sky-900 border border-sky-700/60 text-sky-200 text-xs font-semibold transition shadow-sm"
                    title="Xem toàn bộ lịch sử link Google Drive đã nạp vào kho"
                  >
                    <Cloud className="w-4 h-4 text-sky-400" />
                    <span>Lịch sử link Drive ({allDriveLinks.length})</span>
                  </button>
                  <button
                    onClick={() => masterFolderInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
                    title="Upload thư mục chứa 5 folder OPEN, PRODUCT, TEXTURE, APPLY, END từ máy tính"
                  >
                    <FolderSync className="w-4 h-4 text-indigo-400" />
                    <span>Chọn thư mục tổng từ máy (tự phân 5 cột)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowClearConfirmModal(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-slate-100 transition shadow-md shadow-rose-600/20"
                    title="Xóa toàn bộ clip trong kho, voice và danh sách tổ hợp"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Xóa</span>
                  </button>
                </div>
              </div>

              {/* Thanh tra cứu nhanh link Drive */}
              <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-3 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Search className="w-4 h-4 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    value={quickCheckInput}
                    onChange={(e) => setQuickCheckInput(e.target.value)}
                    placeholder="Kiểm tra nhanh: Dán link Google Drive hoặc File ID vào đây để kiểm tra đã nạp chưa..."
                    className="bg-transparent border-none text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none w-full font-mono"
                  />
                  {quickCheckInput && (
                    <button
                      type="button"
                      onClick={() => setQuickCheckInput("")}
                      className="p-1 rounded text-slate-500 hover:text-slate-300 transition"
                      title="Xóa tìm kiếm"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {quickCheckResult && (
                  <div className="flex items-center gap-2 shrink-0 text-xs font-medium">
                    {quickCheckResult.found ? (
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span>
                          Đã có {quickCheckResult.matches.length} file (
                          {quickCheckResult.matches
                            .map((m) => m.category.toUpperCase())
                            .join(", ")}
                          )
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setDriveHistorySearchText(quickCheckInput);
                            setShowDriveHistoryDrawer(true);
                          }}
                          className="text-[11px] underline ml-1 text-emerald-200 hover:text-white cursor-pointer"
                        >
                          Xem chi tiết
                        </button>
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300">
                        <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                        <span>Chưa có trong kho (hợp lệ để dán nạp)</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Mode chính: Dán nhanh bảng 5 cột từ Excel */}
              <div className="bg-slate-950/80 border border-sky-500/30 rounded-xl p-4 space-y-3 shadow-lg shadow-sky-950/20">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/40">
                      <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-white flex items-center gap-2">
                        <span>
                          Dán nhanh bảng 5 cột từ Excel (Google Drive)
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40">
                          Mode chính • Zero-disk stream
                        </span>
                      </h3>
                      <p className="text-[11px] text-slate-400">
                        Bôi đen cả bảng 5 cột (Open, Product, Texture, Apply,
                        End) trong file Excel rồi dán (Ctrl+V) vào khung bên
                        dưới.
                      </p>
                    </div>
                  </div>

                  {parsedExcel.totalExtracted > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setExcelPasteText("")}
                        className="px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-200 transition"
                      >
                        Xoá nội dung dán
                      </button>
                      <button
                        type="button"
                        onClick={handleIngestExcelDriveLinks}
                        disabled={isIngestingDrive}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-md shadow-emerald-600/20 disabled:opacity-50"
                      >
                        {isIngestingDrive ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Cloud className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {isIngestingDrive
                            ? "Đang nạp file..."
                            : `+ Nạp ${parsedExcel.totalExtracted} file vào kho (5 category & voice)`}
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="relative">
                  <textarea
                    rows={3}
                    value={excelPasteText}
                    onChange={(e) => setExcelPasteText(e.target.value)}
                    placeholder="Dán vùng dữ liệu copy từ Excel vào đây (hệ thống tự động phân tách Tab thành các cột: Open, Product, Texture, Apply, End, Voice)..."
                    className="w-full px-3.5 py-2.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition resize-y"
                  />
                </div>
              </div>

              {/* 6 Category & Voice Columns in 3x2 Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {CATEGORY_ORDER.map((catKey) => {
                  const meta = SHOT_CATEGORIES.find((c) => c.id === catKey);
                  const items = categoryPools[catKey] || [];
                  return (
                    <div
                      key={catKey}
                      className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between space-y-2.5 min-h-[220px]"
                    >
                      {/* Header: Badge & Count on left, Action buttons on right */}
                      <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                              meta?.badgeClass ||
                              "border-slate-700 text-slate-200"
                            }`}
                          >
                            {meta?.label}
                          </span>
                          <span className="text-xs font-mono font-bold text-white bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                            {items.length} clip
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setSingleCategoryDriveModal({
                                category: catKey,
                                text: "",
                              })
                            }
                            className="py-1 px-2 rounded-lg bg-sky-950/60 hover:bg-sky-900/80 border border-sky-800/60 text-[10px] font-semibold text-sky-200 flex items-center gap-1 transition shadow-sm"
                            title="Dán link Google Drive cho mục này"
                          >
                            <Link2 className="w-3 h-3 text-sky-400 shrink-0" />
                            <span>Link Drive</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              categoryInputRefs.current[catKey]?.click()
                            }
                            className="py-1 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] font-semibold text-slate-300 flex items-center gap-1 transition shadow-sm"
                            title="Tải file clip từ máy tính"
                          >
                            <Plus className="w-3 h-3 text-slate-400 shrink-0" />
                            <span>File</span>
                          </button>
                        </div>
                      </div>

                      {/* Items List */}
                      <div className="flex-1 space-y-1.5 max-h-64 overflow-y-auto pr-1">
                        {items.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-center p-3 text-[11px] text-slate-500">
                            Chưa có clip nào
                          </div>
                        ) : (
                          items.map((it) => {
                            const isDrive =
                              it.sourceType === "drive" || !!it.driveFileId;
                            const driveFileId =
                              it.driveFileId ||
                              extractGoogleDriveFileId(it.localUrl);
                            const driveUrl = driveFileId
                              ? `https://drive.google.com/file/d/${driveFileId}/view`
                              : isDrive
                                ? it.localUrl
                                : null;

                            return (
                              <div
                                key={it.id}
                                className="p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] space-y-1 group hover:border-slate-700 transition"
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <div className="min-w-0 flex items-center gap-1.5 truncate">
                                    {isDrive ? (
                                      <span title="Link Google Drive (Zero-disk stream)">
                                        <Cloud className="w-3 h-3 text-sky-400 shrink-0" />
                                      </span>
                                    ) : (
                                      <span title="File video từ máy tính">
                                        <Film className="w-3 h-3 text-slate-400 shrink-0" />
                                      </span>
                                    )}
                                    {it.lockFlipH && (
                                      <span title="Khóa lật gương">
                                        <Lock className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                                      </span>
                                    )}
                                    <span
                                      className="truncate text-slate-200 font-medium"
                                      title={it.name}
                                    >
                                      {it.name}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <span className="font-mono text-slate-400 font-semibold">
                                      {it.duration.toFixed(1)}s
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleRemoveCategoryItem(catKey, it.id)
                                      }
                                      className="text-slate-500 hover:text-rose-400 opacity-60 group-hover:opacity-100 transition p-0.5 rounded hover:bg-slate-800"
                                      title="Xóa clip này khỏi kho"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>

                                {driveUrl && (
                                  <div className="flex items-center justify-between gap-1.5 pl-4 text-[9px] font-mono text-slate-400 bg-slate-950/60 rounded px-1.5 py-0.5 border border-slate-800/60">
                                    <a
                                      href={driveUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sky-400 hover:text-sky-300 hover:underline truncate max-w-[170px] inline-flex items-center gap-1"
                                      title={`Mở link Drive: ${driveUrl}`}
                                    >
                                      <span className="truncate">{driveUrl}</span>
                                      <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-70" />
                                    </a>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        navigator.clipboard.writeText(driveUrl);
                                        addToast({
                                          type: "info",
                                          text: "Đã sao chép link Google Drive.",
                                        });
                                      }}
                                      className="text-slate-500 hover:text-slate-200 p-0.5 rounded transition shrink-0"
                                      title="Sao chép link Drive"
                                    >
                                      <Copy className="w-2.5 h-2.5" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Box 6: VOICE (LỒNG TIẾNG) */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between space-y-2.5 min-h-[220px]">
                  {/* Header: Badge & Count on left, Action buttons on right */}
                  <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full border border-indigo-500/40 text-indigo-300 bg-indigo-500/10">
                        Voice
                      </span>
                      <span className="text-xs font-mono font-bold text-white bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                        {multiVoices.length} voice
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setSingleCategoryDriveModal({
                            category: "voice",
                            text: "",
                          })
                        }
                        className="py-1 px-2 rounded-lg bg-sky-950/60 hover:bg-sky-900/80 border border-sky-800/60 text-[10px] font-semibold text-sky-200 flex items-center gap-1 transition shadow-sm"
                        title="Dán link Google Drive cho lồng tiếng"
                      >
                        <Link2 className="w-3 h-3 text-sky-400 shrink-0" />
                        <span>Link Drive</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => voiceInputRef.current?.click()}
                        className="py-1 px-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] font-semibold text-slate-300 flex items-center gap-1 transition shadow-sm"
                        title="Tải file voice từ máy tính"
                      >
                        <Plus className="w-3 h-3 text-slate-400 shrink-0" />
                        <span>File</span>
                      </button>
                    </div>
                  </div>

                  {/* Inline Voice Mode Toggle */}
                  <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-900/70 border border-slate-800/80 text-[11px]">
                    <span className="text-slate-400 font-medium">
                      Chế độ lồng tiếng:
                    </span>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name="boxVoiceMode"
                          checked={mixVoiceMode === "none"}
                          onChange={() => setMixVoiceMode("none")}
                          className="accent-indigo-500"
                        />
                        <span
                          className={
                            mixVoiceMode === "none"
                              ? "text-slate-200"
                              : "text-slate-500"
                          }
                        >
                          Không lồng
                        </span>
                      </label>
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="radio"
                          name="boxVoiceMode"
                          checked={mixVoiceMode === "rotate"}
                          onChange={() => setMixVoiceMode("rotate")}
                          className="accent-indigo-500"
                        />
                        <span
                          className={
                            mixVoiceMode === "rotate"
                              ? "text-indigo-300 font-medium"
                              : "text-slate-500"
                          }
                        >
                          Xoay vòng
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Voice Items List */}
                  <div className="flex-1 space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {multiVoices.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center p-3 text-[11px] text-slate-500">
                        Chưa có voice nào
                      </div>
                    ) : (
                      multiVoices.map((v) => {
                        const isDrive =
                          v.sourceType === "drive" || !!v.driveFileId;
                        const driveFileId =
                          v.driveFileId ||
                          extractGoogleDriveFileId(v.driveRawUrl || "");
                        const driveUrl =
                          v.driveRawUrl ||
                          (driveFileId
                            ? `https://drive.google.com/file/d/${driveFileId}/view`
                            : isDrive
                              ? v.localUrl
                              : null);

                        return (
                          <div
                            key={v.id}
                            className="p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] space-y-1 group hover:border-slate-700 transition"
                          >
                            <div className="flex items-center justify-between gap-1.5">
                              <div className="flex items-center gap-1.5 truncate min-w-0">
                                <button
                                  type="button"
                                  onClick={() => handleToggleAuditionVoice(v)}
                                  className={`p-1 rounded transition shrink-0 ${
                                    auditionVoiceId === v.id
                                      ? "bg-indigo-600 text-white"
                                      : "text-slate-400 hover:text-indigo-300 hover:bg-slate-800"
                                  }`}
                                  title={
                                    auditionVoiceId === v.id
                                      ? "Dừng nghe thử"
                                      : "Nghe thử file này"
                                  }
                                >
                                  {auditionVoiceId === v.id ? (
                                    <Square className="w-2.5 h-2.5 fill-current" />
                                  ) : (
                                    <Play className="w-2.5 h-2.5 fill-current" />
                                  )}
                                </button>
                                {isDrive ? (
                                  <span title="Link Google Drive (Zero-disk stream)">
                                    <Cloud className="w-3 h-3 text-sky-400 shrink-0" />
                                  </span>
                                ) : (
                                  <span title="File âm thanh từ máy tính">
                                    <Music className="w-3 h-3 text-slate-400 shrink-0" />
                                  </span>
                                )}
                                <span
                                  className="truncate text-slate-200 font-medium"
                                  title={v.name}
                                >
                                  {v.name}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="font-mono text-slate-400 font-semibold">
                                  {v.duration.toFixed(1)}s
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveVoiceItem(v.id)}
                                  className="text-slate-500 hover:text-rose-400 opacity-60 group-hover:opacity-100 transition p-0.5 rounded hover:bg-slate-800"
                                  title="Xóa voice này khỏi kho"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>

                            {driveUrl && (
                              <div className="flex items-center justify-between gap-1.5 pl-5 text-[9px] font-mono text-slate-400 bg-slate-950/60 rounded px-1.5 py-0.5 border border-slate-800/60">
                                <a
                                  href={driveUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sky-400 hover:text-sky-300 hover:underline truncate max-w-[170px] inline-flex items-center gap-1"
                                  title={`Mở link Drive: ${driveUrl}`}
                                >
                                  <span className="truncate">{driveUrl}</span>
                                  <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-70" />
                                </a>
                                <button
                                  type="button"
                                  onClick={() => {
                                    navigator.clipboard.writeText(driveUrl);
                                    addToast({
                                      type: "info",
                                      text: "Đã sao chép link Google Drive.",
                                    });
                                  }}
                                  className="text-slate-500 hover:text-slate-200 p-0.5 rounded transition shrink-0"
                                  title="Sao chép link Drive"
                                >
                                  <Copy className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Mixer Settings: Single Clean Row */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 w-full sm:w-auto">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-rose-400 shrink-0" />
                  <label className="text-xs font-bold text-white whitespace-nowrap">
                    Số video muốn tạo:
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={targetMixCount}
                    onChange={(e) =>
                      setTargetMixCount(
                        Math.max(1, Math.min(50, parseInt(e.target.value) || 1)),
                      )
                    }
                    className="w-24 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono font-bold text-center text-white focus:outline-none focus:border-rose-500"
                  />
                  <span className="text-[11px] text-slate-400 hidden md:inline">
                    video (Tối đa 50 video • Tự động kết hợp các cảnh và voice theo thuật toán
                    ngẫu nhiên có kiểm soát)
                  </span>
                </div>
              </div>

              <div className="w-full sm:w-auto shrink-0 flex items-center gap-2">
                <button
                  onClick={handlePlanDiverseMix}
                  className="w-full sm:w-auto px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-xs sm:text-sm shadow-xl shadow-indigo-600/20 flex items-center justify-center gap-2 transition"
                >
                  <Sparkles className="w-4 h-4 animate-pulse" />
                  <span>Tạo tổ hợp trộn video</span>
                </button>
              </div>
            </div>

            {/* Generated Composed Videos & 9:16 Canvas Preview */}
            {state?.composedVideos && state.composedVideos.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Left: Combinations List */}
                <div className="lg:col-span-7 bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Danh sách {state.composedVideos.length} tổ hợp video
                      </h3>
                      <p className="text-xs text-slate-400">
                        Click vào cảnh (OPEN, PRODUCT...) để chỉnh tốc độ, cắt
                        giây, lật gương
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleRenderAllComposedZip}
                        disabled={Boolean(busyMessage)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition shadow-md shadow-emerald-600/20 disabled:opacity-50"
                        title="Render toàn bộ video bằng FFmpeg và nén ZIP tải về máy"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Tải ZIP toàn bộ MP4</span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-3 max-h-[550px] overflow-y-auto pr-1">
                    {state.composedVideos.map((comp, idx) => {
                      const isSelected = selectedComposed?.id === comp.id;
                      const activeSlotIdx =
                        isSelected && editingSlotCategory
                          ? comp.slots.findIndex(
                              (s) => s.category === editingSlotCategory,
                            )
                          : -1;
                      const activeSlot =
                        activeSlotIdx >= 0 ? comp.slots[activeSlotIdx] : null;
                      const isCardPlaying =
                        isSelected &&
                        isPreviewPlaying &&
                        previewMode === "full";

                      return (
                        <div
                          key={comp.id}
                          onClick={() => setSelectedComposedId(comp.id)}
                          className={`p-3.5 rounded-xl border transition ${
                            isSelected
                              ? "bg-slate-800/95 border-rose-500/80 shadow-lg shadow-rose-500/10"
                              : "bg-slate-950/70 border-slate-800 hover:border-slate-700"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2.5">
                            <span className="text-xs font-bold text-white flex items-center gap-2">
                              <span>
                                #{idx + 1} — {comp.name}
                              </span>
                              <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold">
                                ⏱️ Tổng: {comp.finalDuration.toFixed(1)}s
                              </span>
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isCardPlaying) {
                                    setPauseTrigger((prev) => prev + 1);
                                  } else {
                                    setSelectedComposedId(comp.id);
                                    setEditingSlotCategory(null);
                                    setActiveSlotFocusIndex(null);
                                    setPreviewMode("full");
                                    setPlayTrigger((prev) => prev + 1);
                                  }
                                }}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-white text-[11px] font-bold shadow-md transition ${
                                  isCardPlaying
                                    ? "bg-amber-600 hover:bg-amber-500 shadow-amber-600/20"
                                    : "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20"
                                }`}
                                title={
                                  isCardPlaying
                                    ? "Tạm dừng phát thử"
                                    : "Xem trước toàn bộ video (5 cảnh)"
                                }
                              >
                                {isCardPlaying ? (
                                  <>
                                    <Pause className="w-3 h-3 fill-current" />
                                    <span>Tạm dừng</span>
                                  </>
                                ) : (
                                  <>
                                    <Play className="w-3 h-3 fill-current" />
                                    <span>Phát</span>
                                  </>
                                )}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRenderSingleComposed(comp);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold shadow-md shadow-rose-600/20 transition"
                                title="Xuất file MP4 hoàn chỉnh bằng FFmpeg"
                              >
                                <Download className="w-3 h-3" />
                                <span>Xuất MP4</span>
                              </button>
                            </div>
                          </div>

                          {/* 5 Slots Badges */}
                          <div className="grid grid-cols-5 gap-1.5">
                            {comp.slots.map((slot, sIdx) => {
                              const slotDur = (
                                slot.exitEnd - slot.enterBegin
                              ).toFixed(1);
                              const isSlotActive =
                                isSelected &&
                                editingSlotCategory === slot.category;
                              return (
                                <button
                                  key={`${comp.id}_${slot.category}`}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedComposedId(comp.id);
                                    const willBeActive = !isSlotActive;
                                    setEditingSlotCategory(
                                      willBeActive ? slot.category : null,
                                    );
                                    setActiveSlotFocusIndex(
                                      willBeActive ? sIdx : null,
                                    );
                                    setPreviewMode(
                                      willBeActive ? "slot" : "full",
                                    );
                                  }}
                                  className={`p-1.5 rounded-lg text-left border text-[10px] transition cursor-pointer ${
                                    isSlotActive
                                      ? "bg-rose-950/70 border-rose-500 ring-2 ring-rose-500/50 shadow-md shadow-rose-500/20"
                                      : "bg-slate-900 border-slate-800 hover:border-slate-700"
                                  }`}
                                >
                                  <div className="font-bold text-slate-300 uppercase flex items-center justify-between">
                                    <span
                                      className={
                                        isSlotActive
                                          ? "text-rose-300 font-extrabold"
                                          : ""
                                      }
                                    >
                                      {slot.category}
                                    </span>
                                    <span className="font-mono text-rose-300 font-bold">
                                      {slotDur}s
                                    </span>
                                  </div>
                                  <div
                                    className="text-slate-400 truncate mt-0.5 text-[9px]"
                                    title={slot.shotLabel}
                                  >
                                    {slot.shotLabel}
                                  </div>
                                  <div className="font-mono text-[9px] text-slate-500 mt-0.5 flex items-center justify-between">
                                    <span>
                                      {slot.videoBegin.toFixed(1)}s–
                                      {slot.videoEnd.toFixed(1)}s
                                    </span>
                                    <span
                                      className={
                                        slot.speed > 1
                                          ? "text-cyan-400 font-semibold"
                                          : slot.speed < 1
                                            ? "text-amber-400 font-semibold"
                                            : "text-slate-400"
                                      }
                                    >
                                      {slot.speed}x
                                    </span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          {/* Voice Track Selector for this Composed Video */}
                          <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5 text-slate-400">
                              <Mic className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                              <span className="text-[10px] text-slate-300">
                                Lồng tiếng:
                              </span>
                            </div>
                            <select
                              value={comp.voiceTrackId || ""}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                e.stopPropagation();
                                handleChangeComposedVoice(
                                  comp.id,
                                  e.target.value || null,
                                );
                              }}
                              className="bg-slate-900 border border-slate-700 text-indigo-300 text-[10px] rounded-lg px-2 py-0.5 focus:outline-none focus:border-indigo-500 max-w-[210px] truncate"
                            >
                              <option value="">(Không lồng voice)</option>
                              {multiVoices.map((v) => (
                                <option key={v.id} value={v.id}>
                                  🎵 {v.name} ({v.duration.toFixed(1)}s)
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Inline Scene Inspector */}
                          {isSelected && activeSlot && activeSlotIdx >= 0 && (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="mt-3 p-3.5 rounded-xl bg-slate-900 border border-rose-500/40 space-y-3 animate-in fade-in duration-200"
                            >
                              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-bold text-rose-300 uppercase px-2 py-0.5 rounded-md bg-rose-500/20 border border-rose-500/30">
                                    Cảnh {activeSlot.category}
                                  </span>
                                  <span
                                    className="text-xs text-slate-200 truncate max-w-[180px]"
                                    title={activeSlot.shotLabel}
                                  >
                                    {activeSlot.shotLabel}
                                  </span>
                                  <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">
                                    (Gốc:{" "}
                                    {(
                                      activeSlot.originalVideoEnd ||
                                      activeSlot.videoEnd
                                    ).toFixed(1)}
                                    s)
                                  </span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {/* Compact Mirror Toggle Button */}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateComposedSlot(
                                        comp.id,
                                        activeSlotIdx,
                                        {
                                          flipH: !activeSlot.flipH,
                                        },
                                      )
                                    }
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold border transition ${
                                      activeSlot.flipH
                                        ? "bg-rose-600/30 text-rose-300 border-rose-500/60 shadow-sm"
                                        : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
                                    }`}
                                    title="Lật gương ngang hình ảnh (Mirror)"
                                  >
                                    <FlipHorizontal className="w-3.5 h-3.5" />
                                    <span>
                                      {activeSlot.flipH
                                        ? "Đang lật gương"
                                        : "Lật gương"}
                                    </span>
                                  </button>

                                  <button
                                    onClick={() => {
                                      setPreviewMode("slot");
                                      setActiveSlotFocusIndex(activeSlotIdx);
                                      setPlayTrigger((prev) => prev + 1);
                                    }}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-200 transition"
                                    title="Phát thử đoạn video này trên player"
                                  >
                                    <Play className="w-3 h-3 text-rose-400 fill-current" />
                                    <span>Xem đoạn này</span>
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditingSlotCategory(null);
                                      setPreviewMode("full");
                                    }}
                                    className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-slate-800"
                                    title="Thu gọn bảng chỉnh sửa"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                                {/* Speed Controls */}
                                <div className="space-y-1.5 p-2.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-col justify-between">
                                  <div>
                                    <label className="text-[11px] font-semibold text-slate-300 flex items-center justify-between mb-1.5">
                                      <span>Tốc độ phát:</span>
                                      <span className="text-rose-400 font-mono font-bold">
                                        {activeSlot.speed}x
                                      </span>
                                    </label>
                                    <div className="flex items-center gap-1 flex-wrap mb-2">
                                      {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map(
                                        (spd) => (
                                          <button
                                            key={spd}
                                            type="button"
                                            onClick={() =>
                                              handleUpdateComposedSlot(
                                                comp.id,
                                                activeSlotIdx,
                                                { speed: spd },
                                              )
                                            }
                                            className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition ${
                                              activeSlot.speed === spd
                                                ? "bg-rose-600 text-white font-bold"
                                                : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                                            }`}
                                          >
                                            {spd}x
                                          </button>
                                        ),
                                      )}
                                    </div>
                                    <input
                                      type="range"
                                      min="0.25"
                                      max="3.0"
                                      step="0.05"
                                      value={activeSlot.speed}
                                      onChange={(e) =>
                                        handleUpdateComposedSlot(
                                          comp.id,
                                          activeSlotIdx,
                                          {
                                            speed:
                                              parseFloat(e.target.value) || 1.0,
                                          },
                                        )
                                      }
                                      className="w-full accent-rose-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                                    />
                                  </div>
                                  <p className="text-[10px] text-slate-400 font-mono pt-1 border-t border-slate-800/80">
                                    Cắt{" "}
                                    {(
                                      activeSlot.videoEnd -
                                      activeSlot.videoBegin
                                    ).toFixed(1)}
                                    s ÷ {activeSlot.speed}x ={" "}
                                    <span className="text-emerald-400 font-bold">
                                      {(
                                        (activeSlot.videoEnd -
                                          activeSlot.videoBegin) /
                                        activeSlot.speed
                                      ).toFixed(1)}
                                      s
                                    </span>
                                  </p>
                                </div>

                                {/* Apple Photos / iPhone Dual-Handle Video Trimmer (2 cols) */}
                                <div className="sm:col-span-2">
                                  <IPhoneVideoTrimmer
                                    videoBegin={activeSlot.videoBegin}
                                    videoEnd={activeSlot.videoEnd}
                                    maxDuration={
                                      activeSlot.originalVideoEnd ||
                                      activeSlot.videoEnd ||
                                      10
                                    }
                                    onChange={(begin, end) =>
                                      handleUpdateComposedSlot(
                                        comp.id,
                                        activeSlotIdx,
                                        {
                                          videoBegin: begin,
                                          videoEnd: end,
                                        },
                                      )
                                    }
                                    onScrubStart={() => {
                                      setIsScrubbing(true);
                                      setPreviewMode("slot");
                                      setActiveSlotFocusIndex(activeSlotIdx);
                                    }}
                                    onScrubMove={(sourceSec) => {
                                      setScrubSourceSec(sourceSec);
                                    }}
                                    onScrubEnd={() => {
                                      setIsScrubbing(false);
                                    }}
                                    onSeekPreview={(targetSec) => {
                                      setActiveSlotFocusIndex(activeSlotIdx);
                                      const timelinePos =
                                        activeSlot.enterBegin +
                                        (targetSec - activeSlot.videoBegin) /
                                          (activeSlot.speed || 1);
                                      setPreviewSeekSec(timelinePos);
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Right: 9:16 Canvas Preview */}
                <div className="lg:col-span-5 bg-slate-900/70 border border-slate-800 rounded-2xl p-5 flex flex-col items-center justify-between space-y-4">
                  <div className="w-full flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Web canvas preview 9:16
                      </h3>
                      <p className="text-xs text-slate-400">
                        Chuyển cảnh 0ms (Ping-Pong Video A/B)
                      </p>
                    </div>
                  </div>

                  {selectedComposed ? (
                    <PreviewPlayer916
                      composed={selectedComposed}
                      sourceVideo={state.sourceVideo}
                      voiceTrack={selectedVoiceTrack}
                      enableVoice={Boolean(selectedVoiceTrack)}
                      previewMode={previewMode}
                      isolatedSlotIndex={
                        previewMode === "slot" &&
                        typeof activeSlotFocusIndex === "number"
                          ? activeSlotFocusIndex
                          : null
                      }
                      isScrubbing={isScrubbing}
                      scrubSourceSec={scrubSourceSec}
                      playTrigger={playTrigger}
                      pauseTrigger={pauseTrigger}
                      onPlayingChange={setIsPreviewPlaying}
                      activeSlotFocusIndex={activeSlotFocusIndex}
                      seekTimelineSec={previewSeekSec}
                      onSlotFocusChange={(idx) => {
                        setActiveSlotFocusIndex(idx);
                        const cat = selectedComposed.slots[idx]?.category;
                        if (cat) setEditingSlotCategory(cat);
                        setPreviewMode("slot");
                      }}
                    />
                  ) : (
                    <div className="h-[480px] flex items-center justify-center text-xs text-slate-500">
                      Hãy tạo tổ hợp để xem trước.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Direct Local Export Section */}
            {state?.composedVideos && state.composedVideos.length > 0 && (
              <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-bold flex items-center gap-2 text-white">
                      <Download className="w-4 h-4 text-emerald-400" />
                      <span>Xuất toàn bộ các video tổ hợp về máy tính</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Render trực tiếp qua FFmpeg (1080×1920 MP4) và lưu thẳng
                      về máy không qua trung gian.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={handleRenderAllComposedZip}
                      disabled={Boolean(busyMessage)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg shadow-emerald-600/20 disabled:opacity-50"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>
                        Tải ZIP toàn bộ ({state.composedVideos.length} MP4)
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: LỊCH SỬ RENDER */}
        {mainTab === "history" && (
          <div className="space-y-5 animate-in fade-in duration-150">
            {/* Header Toolbar */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/15 flex items-center justify-center border border-indigo-500/30 text-indigo-400 shrink-0">
                    <History className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-extrabold text-white flex items-center gap-2.5">
                      <span>Lịch sử video đã render</span>
                      <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                        {renderedHistoryList.length} video
                      </span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Quản lý trạng thái sử dụng của từng video đã xuất file. Thuật toán tự động ghi nhận và loại trừ các cảnh này khi tạo mẻ video mới.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Export Dropdown */}
                  <div className="relative">
                    <button
                      type="button"
                      disabled={renderedHistoryList.length === 0}
                      onClick={() => setShowExportMenu((prev) => !prev)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition disabled:opacity-50"
                      title="Xuất toàn bộ lịch sử video ra file bảng tính"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Xuất file</span>
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                    </button>

                    {showExportMenu && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setShowExportMenu(false)}
                        />
                        <div className="absolute right-0 mt-1.5 w-48 rounded-xl bg-slate-900 border border-slate-700/80 shadow-2xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-150">
                          <button
                            type="button"
                            onClick={() => handleExportHistory("xlsx")}
                            className="w-full px-3.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 hover:text-white flex items-center gap-2 transition"
                          >
                            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                            <span>Xuất Excel (.xlsx)</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleExportHistory("csv")}
                            className="w-full px-3.5 py-2 text-left text-xs font-medium text-slate-200 hover:bg-slate-800 hover:text-white flex items-center gap-2 transition"
                          >
                            <Code2 className="w-4 h-4 text-sky-400" />
                            <span>Xuất CSV (.csv)</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={fetchRenderedHistory}
                    disabled={isLoadingHistory}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition disabled:opacity-50"
                    title="Tải lại danh sách lịch sử"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        isLoadingHistory ? "animate-spin text-indigo-400" : ""
                      }`}
                    />
                    <span>Làm mới</span>
                  </button>
                  {renderedHistoryList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowClearHistoryConfirmModal(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-semibold transition"
                      title="Xóa toàn bộ lịch sử video đã render của dự án này"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Xóa toàn bộ lịch sử</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Filters, Search & Sort Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800/80">
                {/* Status Filter Tabs */}
                <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
                  <button
                    type="button"
                    onClick={() => setHistoryFilterStatus("all")}
                    className={`px-3 py-1.5 rounded-lg font-semibold transition ${
                      historyFilterStatus === "all"
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Tất cả ({historyCounts.all})
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryFilterStatus("unused")}
                    className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
                      historyFilterStatus === "unused"
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-slate-400" />
                    <span>Chưa sử dụng ({historyCounts.unused})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setHistoryFilterStatus("used")}
                    className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
                      historyFilterStatus === "used"
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span>Đã sử dụng ({historyCounts.used})</span>
                  </button>
                </div>

                <div className="flex items-center gap-2 flex-1 sm:flex-initial justify-end">
                  {/* Search Input */}
                  <div className="relative flex-1 sm:w-64">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={historySearchText}
                      onChange={(e) => setHistorySearchText(e.target.value)}
                      placeholder="Tìm theo tên video, cảnh..."
                      className="w-full pl-8 pr-7 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition"
                    />
                    {historySearchText && (
                      <button
                        type="button"
                        onClick={() => setHistorySearchText("")}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-xs"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Sort Order Toggle */}
                  <button
                    type="button"
                    onClick={() =>
                      setHistorySortOrder((prev) =>
                        prev === "desc" ? "asc" : "desc",
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 transition"
                    title={`Đang sắp xếp: ${
                      historySortOrder === "desc"
                        ? "Mới nhất trước"
                        : "Cũ nhất trước"
                    }`}
                  >
                    <ArrowUpDown className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="hidden sm:inline">
                      {historySortOrder === "desc"
                        ? "Mới nhất trước"
                        : "Cũ nhất trước"}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Table or Empty/Loading State */}
            {isLoadingHistory ? (
              <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-400">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                <span className="text-xs font-medium">
                  Đang tải danh sách lịch sử render...
                </span>
              </div>
            ) : renderedHistoryList.length === 0 ? (
              <div className="py-20 px-6 rounded-2xl bg-slate-900/50 border border-slate-800/80 flex flex-col items-center justify-center text-center space-y-4">
                <div className="w-16 h-16 rounded-2xl bg-slate-800/60 border border-slate-700/60 flex items-center justify-center text-slate-500 shadow-inner">
                  <Film className="w-8 h-8" />
                </div>
                <div className="max-w-md space-y-1">
                  <h3 className="text-sm font-bold text-white">
                    Chưa có video nào trong lịch sử render
                  </h3>
                  <p className="text-xs text-slate-400">
                    Khi bạn xuất file MP4 đơn lẻ hoặc tải ZIP toàn bộ ở tab
                    &quot;Trộn ghép&quot;, các video sẽ tự động được lưu vào đây và không
                    bị trùng cảnh ở các lần tạo tiếp theo.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMainTab("mix")}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/25"
                >
                  <Shuffle className="w-4 h-4" />
                  <span>Sang tab trộn ghép ngay</span>
                </button>
              </div>
            ) : filteredHistoryList.length === 0 ? (
              <div className="py-16 px-6 rounded-2xl bg-slate-900/40 border border-slate-800/80 flex flex-col items-center justify-center text-center space-y-2">
                <Search className="w-7 h-7 text-slate-500 mb-1" />
                <h3 className="text-sm font-bold text-white">
                  Không tìm thấy video phù hợp
                </h3>
                <p className="text-xs text-slate-400">
                  Thử đổi bộ lọc trạng thái hoặc từ khóa tìm kiếm khác.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setHistoryFilterStatus("all");
                    setHistorySearchText("");
                  }}
                  className="mt-2 text-xs font-semibold text-indigo-400 hover:text-indigo-300 underline"
                >
                  Đặt lại bộ lọc
                </button>
              </div>
            ) : (
              <div className="bg-slate-900/80 border border-slate-800 rounded-2xl overflow-hidden shadow-sm flex flex-col">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                        <th className="py-3.5 px-4 w-12 text-center">STT</th>
                        <th className="py-3.5 px-4 min-w-[220px]">Tên video</th>
                        <th className="py-3.5 px-3 w-28 text-center">Thời lượng</th>
                        <th className="py-3.5 px-4 min-w-[240px]">5 Cảnh tổ hợp</th>
                        <th className="py-3.5 px-3 min-w-[120px]">Voice</th>
                        <th className="py-3.5 px-4 w-44 text-center">Trạng thái</th>
                        <th className="py-3.5 px-4 w-24 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {paginatedHistoryList.map((rec, rIdx) => {
                        const comp = rec.payload as ComposedVideo | undefined;
                        const isUsed = rec.status === "used";
                        const globalIdx =
                          (historyPage - 1) * historyPageSize + rIdx + 1;
                        const dateStr = rec.renderedAt
                          ? new Date(rec.renderedAt).toLocaleString("vi-VN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                            })
                          : "";
                        const voiceItem = comp?.voiceTrackId
                          ? multiVoices.find((v) => v.id === comp.voiceTrackId)
                          : null;

                        return (
                          <tr
                            key={rec.id || rIdx}
                            onClick={() => setSelectedHistoryDetail(rec)}
                            className="hover:bg-slate-800/40 transition cursor-pointer group"
                          >
                            {/* STT */}
                            <td className="py-3 px-4 text-center text-slate-400 font-mono">
                              #{globalIdx}
                            </td>

                            {/* Tên video & ngày render */}
                            <td className="py-3 px-4">
                              <div className="font-bold text-white group-hover:text-indigo-300 transition line-clamp-1">
                                {rec.name || `Video #${globalIdx}`}
                              </div>
                              {dateStr && (
                                <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                                  ⏱️ {dateStr}
                                </div>
                              )}
                            </td>

                            {/* Thời lượng */}
                            <td className="py-3 px-3 text-center">
                              {comp?.finalDuration ? (
                                <span className="inline-block px-2 py-0.5 rounded-full font-mono font-bold text-[11px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                                  {comp.finalDuration.toFixed(1)}s
                                </span>
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>

                            {/* 5 Cảnh tổ hợp */}
                            <td className="py-3 px-4">
                              {comp?.slots && comp.slots.length > 0 ? (
                                <div className="flex items-center gap-1">
                                  {comp.slots.map((s, sIdx) => {
                                    const catMeta = SHOT_CATEGORIES.find(
                                      (c) => c.id === s.category,
                                    );
                                    return (
                                      <div
                                        key={sIdx}
                                        className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold border truncate max-w-[80px] ${
                                          catMeta?.badgeClass ||
                                          "bg-slate-800 text-slate-300 border-slate-700"
                                        }`}
                                        title={`${s.category.toUpperCase()}: ${
                                          s.shotLabel || s.shotId
                                        } (${s.videoBegin.toFixed(1)}s - ${s.videoEnd.toFixed(1)}s)`}
                                      >
                                        {s.category.slice(0, 1).toUpperCase()}:{" "}
                                        {s.shotLabel || s.shotId}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <span
                                  className="text-slate-500 font-mono text-[11px] truncate max-w-[180px] block"
                                  title={rec.tupleKey}
                                >
                                  {rec.tupleKey}
                                </span>
                              )}
                            </td>

                            {/* Voice */}
                            <td className="py-3 px-3">
                              {comp?.voiceTrackId ? (
                                <span
                                  className="inline-flex items-center gap-1 text-[11px] font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 rounded-full truncate max-w-[120px]"
                                  title={voiceItem?.name || "Có lồng voice"}
                                >
                                  🎙️ {voiceItem?.name || "Voice"}
                                </span>
                              ) : (
                                <span className="text-slate-500 font-mono">
                                  -
                                </span>
                              )}
                            </td>

                            {/* Trạng thái (Switch toggle) */}
                            <td
                              className="py-3 px-4 text-center"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-center gap-2">
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={isUsed}
                                  onClick={(e) =>
                                    handleToggleHistoryStatus(rec, e)
                                  }
                                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                    isUsed ? "bg-emerald-500" : "bg-slate-700"
                                  }`}
                                  title={
                                    isUsed
                                      ? "Bấm để đánh dấu là chưa sử dụng"
                                      : "Bấm để đánh dấu là đã sử dụng"
                                  }
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                      isUsed
                                        ? "translate-x-4"
                                        : "translate-x-0"
                                    }`}
                                  />
                                </button>
                                <span
                                  className={`text-[11px] font-medium select-none min-w-[75px] text-left ${
                                    isUsed
                                      ? "text-emerald-400 font-bold"
                                      : "text-slate-400"
                                  }`}
                                >
                                  {isUsed ? "Đã dùng" : "Chưa dùng"}
                                </span>
                              </div>
                            </td>

                            {/* Thao tác */}
                            <td
                              className="py-3 px-4 text-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-end gap-1.5">
                                {comp && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleRenderSingleComposed(comp)
                                    }
                                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                                    title="Tải lại file MP4 này về máy"
                                  >
                                    <Download className="w-3.5 h-3.5 text-emerald-400" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleDeleteHistoryItem(rec.id)
                                  }
                                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition"
                                  title="Xóa bản ghi này khỏi lịch sử"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Footer */}
                <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-t border-slate-800/80 bg-slate-950/40 text-xs text-slate-400">
                  <div className="flex items-center gap-2">
                    <span>
                      Hiển thị{" "}
                      <strong className="text-white">
                        {(historyPage - 1) * historyPageSize + 1}
                      </strong>
                      –
                      <strong className="text-white">
                        {Math.min(
                          filteredHistoryList.length,
                          historyPage * historyPageSize,
                        )}
                      </strong>{" "}
                      trên tổng số{" "}
                      <strong className="text-white">
                        {filteredHistoryList.length}
                      </strong>{" "}
                      video
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* Page Size Selector */}
                    <div className="flex items-center gap-1.5">
                      <span>Dòng mỗi trang:</span>
                      <select
                        value={historyPageSize}
                        onChange={(e) =>
                          setHistoryPageSize(Number(e.target.value))
                        }
                        className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                      >
                        <option value={10}>10</option>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                      </select>
                    </div>

                    {/* Pagination Page Controls */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={historyPage <= 1}
                        onClick={() =>
                          setHistoryPage((prev) => Math.max(1, prev - 1))
                        }
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 disabled:hover:bg-slate-800 transition"
                        title="Trang trước"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="px-2 font-mono text-slate-300">
                        {historyPage} / {totalHistoryPages}
                      </span>
                      <button
                        type="button"
                        disabled={historyPage >= totalHistoryPages}
                        onClick={() =>
                          setHistoryPage((prev) =>
                            Math.min(totalHistoryPages, prev + 1),
                          )
                        }
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 disabled:hover:bg-slate-800 transition"
                        title="Trang tiếp theo"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SLIDE-OVER DRAWER CHI TIẾT VIDEO (TRƯỢT TỪ BÊN PHẢI) */}
            {selectedHistoryDetail && (
              <div className="fixed inset-0 z-50 overflow-hidden animate-in fade-in duration-200">
                {/* Backdrop */}
                <div
                  onClick={() => setSelectedHistoryDetail(null)}
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
                />

                <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
                  <div className="w-screen max-w-xl sm:max-w-2xl bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col justify-between animate-in slide-in-from-right duration-300 overflow-hidden">
                    {/* Drawer Header */}
                    <div className="p-5 border-b border-slate-800 flex items-center justify-between gap-4 bg-slate-950/60">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-extrabold text-white truncate">
                            {selectedHistoryDetail.name || "Chi tiết video"}
                          </h3>
                        </div>
                        {selectedHistoryDetail.renderedAt && (
                          <p className="text-xs text-slate-400 font-mono mt-0.5">
                            ⏱️ Đã render lúc:{" "}
                            {new Date(
                              selectedHistoryDetail.renderedAt,
                            ).toLocaleString("vi-VN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                            })}
                          </p>
                        )}
                      </div>

                      {/* Status Toggle on Drawer Header */}
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 rounded-xl border border-slate-800">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={
                              selectedHistoryDetail.status === "used"
                            }
                            onClick={() =>
                              handleToggleHistoryStatus(selectedHistoryDetail)
                            }
                            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                              selectedHistoryDetail.status === "used"
                                ? "bg-emerald-500"
                                : "bg-slate-700"
                            }`}
                            title="Bấm để đổi trạng thái sử dụng"
                          >
                            <span
                              aria-hidden="true"
                              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                selectedHistoryDetail.status === "used"
                                  ? "translate-x-4"
                                  : "translate-x-0"
                              }`}
                            />
                          </button>
                          <span
                            className={`text-xs font-semibold select-none ${
                              selectedHistoryDetail.status === "used"
                                ? "text-emerald-400 font-bold"
                                : "text-slate-400"
                            }`}
                          >
                            {selectedHistoryDetail.status === "used"
                              ? "Đã sử dụng"
                              : "Chưa sử dụng"}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => setSelectedHistoryDetail(null)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
                          title="Đóng chi tiết"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </div>

                    {/* Drawer Body */}
                    <div className="flex-1 overflow-y-auto overflow-x-hidden p-5 sm:p-6 space-y-6 min-w-0">
                      {/* Video Preview Player */}
                      {selectedHistoryDetail.payload ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                              <Play className="w-3.5 h-3.5 text-indigo-400 fill-current" />
                              <span>Màn hình xem lại video 9:16</span>
                            </h4>
                            {(selectedHistoryDetail.payload as ComposedVideo)
                              ?.finalDuration && (
                              <span className="text-xs font-mono font-bold text-emerald-400 px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30">
                                Thời lượng:{" "}
                                {(
                                  selectedHistoryDetail.payload as ComposedVideo
                                ).finalDuration.toFixed(1)}
                                s
                              </span>
                            )}
                          </div>

                          <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 flex justify-center">
                            {(() => {
                              const comp = selectedHistoryDetail.payload as ComposedVideo;
                              const vItem = comp?.voiceTrackId
                                ? multiVoices.find((v) => v.id === comp.voiceTrackId)
                                : null;
                              const vTrack: VoiceTrack | null = vItem
                                ? {
                                    id: vItem.id,
                                    name: vItem.name,
                                    fileName: vItem.fileName,
                                    localUrl: vItem.localUrl,
                                    localPath: vItem.localPath || "",
                                    sizeBytes: 0,
                                    duration: vItem.duration || 20,
                                    createdAt: "",
                                  }
                                : null;
                              return (
                                <PreviewPlayer916
                                  composed={comp}
                                  sourceVideo={state.sourceVideo}
                                  voiceTrack={vTrack}
                                  enableVoice={Boolean(vTrack)}
                                />
                              );
                            })()}
                          </div>
                        </div>
                      ) : (
                        <div className="p-8 rounded-2xl bg-slate-950 border border-slate-800 text-center text-xs text-slate-500">
                          Bản ghi này thuộc phiên bản trước, không có snapshot
                          cảnh để preview trực tiếp.
                        </div>
                      )}

                      {/* 5 Cảnh Category Details */}
                      {(selectedHistoryDetail.payload as ComposedVideo)
                        ?.slots && (
                        <div className="space-y-3">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                            <Layers className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Chi tiết 5 cảnh trong tổ hợp</span>
                          </h4>

                          <div className="space-y-2.5">
                            {(
                              selectedHistoryDetail.payload as ComposedVideo
                            ).slots.map((s, idx) => {
                              const catMeta = SHOT_CATEGORIES.find(
                                (c) => c.id === s.category,
                              );
                              const driveLink = getGoogleDriveLinkFromSlot(s);

                              return (
                                <div
                                  key={idx}
                                  className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                      <span
                                        className={`w-[72px] shrink-0 text-center px-1.5 py-1 rounded text-[10px] font-extrabold uppercase border tracking-wider ${
                                          catMeta?.badgeClass || "text-slate-300"
                                        }`}
                                      >
                                        {s.category}
                                      </span>
                                      <div className="min-w-0 flex-1 space-y-0.5">
                                        <div className="font-semibold text-slate-200 truncate">
                                          {s.shotLabel || s.shotId}
                                        </div>
                                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                                          <span className="shrink-0">
                                            Cắt gốc: {s.videoBegin.toFixed(1)}s →{" "}
                                            {s.videoEnd.toFixed(1)}s
                                          </span>
                                          {driveLink ? (
                                            <>
                                              <span className="text-slate-600 shrink-0">•</span>
                                              <a
                                                href={driveLink}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-sky-400 hover:text-sky-300 hover:underline inline-flex items-center gap-1 truncate max-w-[150px] sm:max-w-[220px]"
                                                title={`Mở video gốc trên Google Drive: ${driveLink}`}
                                              >
                                                <Cloud className="w-3 h-3 text-sky-400 shrink-0" />
                                                <span className="truncate">{driveLink}</span>
                                                <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-70" />
                                              </a>
                                            </>
                                          ) : (
                                            <>
                                              <span className="text-slate-600 shrink-0">•</span>
                                              <span className="text-slate-500 italic shrink-0">File máy tính</span>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2 font-mono text-[11px] shrink-0">
                                      {s.speed && s.speed !== 1 && (
                                        <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
                                          {s.speed}x
                                        </span>
                                      )}
                                      {s.flipH && (
                                        <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-300 border border-fuchsia-500/30">
                                          Mirror
                                        </span>
                                      )}
                                      <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                                        {(s.exitEnd - s.enterBegin).toFixed(1)}s
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Voice Track Details */}
                      {(selectedHistoryDetail.payload as ComposedVideo)
                        ?.voiceTrackId && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                            <Mic className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Giọng lồng tiếng (Voiceover)</span>
                          </h4>
                          {(() => {
                            const vItem = multiVoices.find(
                              (v) =>
                                v.id ===
                                (
                                  selectedHistoryDetail.payload as ComposedVideo
                                ).voiceTrackId,
                            );
                            const voiceDriveLink =
                              getGoogleDriveLinkFromVoice(vItem);

                            return (
                              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0 flex-1 space-y-0.5">
                                    <div className="font-medium text-slate-200 font-mono truncate">
                                      🎙️ {vItem?.name || "Track lồng voice"}
                                    </div>
                                    <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                                      <span className="text-emerald-400 shrink-0">
                                        Đã hòa âm
                                      </span>
                                      {voiceDriveLink ? (
                                        <>
                                          <span className="text-slate-600 shrink-0">•</span>
                                          <a
                                            href={voiceDriveLink}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-sky-400 hover:text-sky-300 hover:underline inline-flex items-center gap-1 truncate max-w-[180px] sm:max-w-[260px]"
                                            title={`Mở file voice trên Google Drive: ${voiceDriveLink}`}
                                          >
                                            <Cloud className="w-3 h-3 text-sky-400 shrink-0" />
                                            <span className="truncate">{voiceDriveLink}</span>
                                            <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-70" />
                                          </a>
                                        </>
                                      ) : (
                                        <>
                                          <span className="text-slate-600 shrink-0">•</span>
                                          <span className="text-slate-500 italic shrink-0">File máy tính</span>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 shrink-0">
                                    Voiceover
                                  </span>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* Tuple Key */}
                      <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500 min-w-0 max-w-full">
                        <p
                          className="truncate min-w-0 flex-1 select-all cursor-text"
                          title={`Mã tổ hợp: ${selectedHistoryDetail.tupleKey}`}
                        >
                          <span className="shrink-0">Mã tổ hợp: </span>
                          <span className="text-slate-400">
                            {selectedHistoryDetail.tupleKey}
                          </span>
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(
                              selectedHistoryDetail.tupleKey,
                            );
                            addToast({
                              type: "info",
                              text: "Đã sao chép mã tổ hợp vào clipboard.",
                            });
                          }}
                          className="shrink-0 p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-slate-300 transition"
                          title="Sao chép mã tổ hợp"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Drawer Footer Actions */}
                    <div className="p-5 border-t border-slate-800 bg-slate-950/80 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        {selectedHistoryDetail.payload && (
                          <button
                            type="button"
                            onClick={() => {
                              handlePreviewHistoryComposed(
                                selectedHistoryDetail,
                              );
                              setSelectedHistoryDetail(null);
                            }}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-sm"
                          >
                            <Shuffle className="w-3.5 h-3.5" />
                            <span>Mở trên tab trộn ghép</span>
                          </button>
                        )}
                        {selectedHistoryDetail.payload && (
                          <button
                            type="button"
                            onClick={() =>
                              handleRenderSingleComposed(
                                selectedHistoryDetail.payload as ComposedVideo,
                              )
                            }
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition"
                          >
                            <Download className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Tải lại MP4</span>
                          </button>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => setSelectedHistoryDetail(null)}
                        className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
                      >
                        Đóng
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Slide-over Drawer: Lịch sử & tra cứu link Google Drive */}
      {showDriveHistoryDrawer && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="absolute inset-0"
            onClick={() => setShowDriveHistoryDrawer(false)}
          />
          <div className="fixed inset-y-0 right-0 max-w-full flex pl-10 pointer-events-none">
            <div className="w-screen max-w-2xl bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col pointer-events-auto animate-in slide-in-from-right duration-300">
              {/* Header */}
              <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
                    <Cloud className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-white">
                        Lịch sử link Google Drive
                      </h3>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40">
                        {allDriveLinks.length} link
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Toàn bộ link Google Drive đã nạp trong kho của dự án
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDriveHistoryDrawer(false)}
                  className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white transition"
                  title="Đóng drawer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Search & Filter Toolbar */}
              <div className="p-4 border-b border-slate-800 bg-slate-900/60 space-y-3">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={driveHistorySearchText}
                    onChange={(e) => setDriveHistorySearchText(e.target.value)}
                    placeholder="Tìm theo link Drive, File ID hoặc tên file..."
                    className="w-full pl-9 pr-9 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500 transition"
                  />
                  {driveHistorySearchText && (
                    <button
                      type="button"
                      onClick={() => setDriveHistorySearchText("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white"
                      title="Xóa tìm kiếm"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Category Filter Pills */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setDriveHistoryCategoryFilter("all")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                      driveHistoryCategoryFilter === "all"
                        ? "bg-sky-600 text-white"
                        : "bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                    }`}
                  >
                    Tất cả ({allDriveLinks.length})
                  </button>
                  {CATEGORY_ORDER.map((cat) => {
                    const count = allDriveLinks.filter(
                      (l) => l.category === cat,
                    ).length;
                    const meta = SHOT_CATEGORIES.find((c) => c.id === cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setDriveHistoryCategoryFilter(cat)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                          driveHistoryCategoryFilter === cat
                            ? "bg-sky-600 text-white"
                            : "bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                        }`}
                      >
                        {meta?.label || cat} ({count})
                      </button>
                    );
                  })}
                  {(() => {
                    const voiceCount = allDriveLinks.filter(
                      (l) => l.category === "voice",
                    ).length;
                    return (
                      <button
                        type="button"
                        onClick={() => setDriveHistoryCategoryFilter("voice")}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                          driveHistoryCategoryFilter === "voice"
                            ? "bg-sky-600 text-white"
                            : "bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                        }`}
                      >
                        Voice ({voiceCount})
                      </button>
                    );
                  })()}
                </div>
              </div>

              {/* Items List */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
                {filteredDriveLinks.length === 0 ? (
                  <div className="h-48 flex flex-col items-center justify-center text-center p-4 text-xs text-slate-400 space-y-2">
                    <Cloud className="w-8 h-8 text-slate-600" />
                    <div>Không tìm thấy link Google Drive nào phù hợp.</div>
                  </div>
                ) : (
                  filteredDriveLinks.map((item) => {
                    const catMeta = SHOT_CATEGORIES.find(
                      (c) => c.id === item.category,
                    );
                    return (
                      <div
                        key={`${item.category}-${item.id}`}
                        className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/90 hover:border-slate-700 transition space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${
                                item.category === "voice"
                                  ? "border-indigo-500/40 text-indigo-300 bg-indigo-500/10"
                                  : catMeta?.badgeClass ||
                                    "border-slate-700 text-slate-200"
                              }`}
                            >
                              {item.category === "voice"
                                ? "Voice"
                                : catMeta?.label || item.category}
                            </span>
                            <span
                              className="text-xs font-medium text-slate-200 truncate"
                              title={item.name}
                            >
                              {item.name}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {item.duration > 0 && (
                              <span className="text-xs font-mono text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                                {item.duration.toFixed(1)}s
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (item.category === "voice") {
                                  handleRemoveVoiceItem(item.id);
                                } else {
                                  handleRemoveCategoryItem(
                                    item.category as ShotCategory,
                                    item.id,
                                  );
                                }
                                addToast({
                                  type: "info",
                                  text: "Đã xóa clip khỏi kho.",
                                });
                              }}
                              className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800 transition"
                              title="Xóa khỏi kho"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Link detail row */}
                        <div className="flex items-center justify-between gap-2 bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-slate-800/80 text-[11px] font-mono">
                          <a
                            href={item.driveUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 hover:text-sky-300 hover:underline truncate inline-flex items-center gap-1.5"
                            title={`Mở link trên Google Drive: ${item.driveUrl}`}
                          >
                            <Cloud className="w-3 h-3 text-sky-400 shrink-0" />
                            <span className="truncate">{item.driveUrl}</span>
                            <ExternalLink className="w-3 h-3 opacity-70 shrink-0" />
                          </a>

                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(item.driveUrl);
                              addToast({
                                type: "info",
                                text: "Đã sao chép link Google Drive vào clipboard.",
                              });
                            }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition shrink-0 text-[10px]"
                            title="Sao chép link"
                          >
                            <Copy className="w-3 h-3" />
                            <span>Sao chép</span>
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="p-4 border-t border-slate-800 bg-slate-950/90 flex items-center justify-between">
                <span className="text-xs text-slate-400 font-mono">
                  Hiển thị {filteredDriveLinks.length} / {allDriveLinks.length}{" "}
                  link Drive
                </span>
                <button
                  type="button"
                  onClick={() => setShowDriveHistoryDrawer(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
                >
                  Đóng
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Single Category Google Drive Paste Modal */}
      {singleCategoryDriveModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-sky-500/20 flex items-center justify-center border border-sky-500/40">
                  <Cloud className="w-4 h-4 text-sky-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Dán link Google Drive cho mục{" "}
                    {singleCategoryDriveModal.category === "voice"
                      ? "Voice (lồng tiếng)"
                      : singleCategoryDriveModal.category.toUpperCase()}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Nhập danh sách link Google Drive công khai (mỗi dòng 1 link
                    hoặc dấu phẩy)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSingleCategoryDriveModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="Đóng modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={6}
              value={singleCategoryDriveModal.text}
              onChange={(e) =>
                setSingleCategoryDriveModal({
                  ...singleCategoryDriveModal,
                  text: e.target.value,
                })
              }
              placeholder="https://drive.google.com/file/d/1abc.../view&#10;https://drive.google.com/file/d/2xyz.../view"
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition resize-y"
            />

            <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setSingleCategoryDriveModal(null)}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
              >
                Đóng
              </button>
              <button
                type="button"
                disabled={
                  !singleCategoryDriveModal.text.trim() || isIngestingDrive
                }
                onClick={() =>
                  handleIngestSingleCategoryDrive(
                    singleCategoryDriveModal.category,
                    singleCategoryDriveModal.text,
                  )
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold transition shadow-lg shadow-sky-600/20 disabled:opacity-50"
              >
                {isIngestingDrive ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                <span>Nạp vào mục này</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Confirmation Modal */}
      {showClearConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl relative overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Ambient subtle glow */}
            <div className="absolute -top-10 -right-10 w-32 h-32 bg-rose-500/15 rounded-full blur-3xl pointer-events-none" />

            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0 text-rose-400">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-white">
                  Xác nhận xoá trắng kho
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Bạn có chắc chắn muốn xóa toàn bộ clip trong kho, các file voice và toàn bộ tổ hợp đã tạo để bắt đầu mẻ mới?
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-slate-950/70 border border-slate-800 p-3 space-y-1.5 text-[11px] text-slate-400">
              <div className="flex items-center gap-2 text-rose-300 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Các mục sẽ bị dọn sạch vĩnh viễn:</span>
              </div>
              <ul className="list-disc list-inside space-y-1 pl-1 text-slate-300">
                <li>Toàn bộ clip trong 5 thư mục (Open, Product, Texture, Apply, End)</li>
                <li>Toàn bộ file voice lồng tiếng đã nạp</li>
                <li>Toàn bộ danh sách tổ hợp video đã tạo trong phiên này</li>
                <li>Dữ liệu lưu trữ trong SQLite Cloud của dự án này</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={isClearingAll}
                onClick={() => setShowClearConfirmModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={isClearingAll}
                onClick={handleConfirmClearAll}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-lg shadow-rose-600/25 disabled:opacity-50"
              >
                {isClearingAll ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>{isClearingAll ? "Đang xóa..." : "Xác nhận xóa sạch"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Render History Confirmation Modal */}
      {showClearHistoryConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl relative overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Ambient subtle glow */}
            <div className="absolute -top-10 -right-10 w-32 h-32 bg-rose-500/15 rounded-full blur-3xl pointer-events-none" />

            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0 text-rose-400">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-white">
                  Xác nhận xóa toàn bộ lịch sử
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Bạn có chắc chắn muốn xóa toàn bộ lịch sử các video đã render của dự án này?
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-slate-950/70 border border-slate-800 p-3 space-y-1.5 text-[11px] text-slate-400">
              <div className="flex items-center gap-2 text-amber-300 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Lưu ý quan trọng:</span>
              </div>
              <ul className="list-disc list-inside space-y-1 pl-1 text-slate-300">
                <li>Toàn bộ {renderedHistoryList.length} bản ghi video đã render sẽ bị xóa khỏi lịch sử.</li>
                <li>Sau khi xóa, các mẻ trộn tiếp theo có thể trùng với các clip/tổ hợp đã từng render trước đây.</li>
                <li>Hành động này không thể hoàn tác.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={isClearingHistory}
                onClick={() => setShowClearHistoryConfirmModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={isClearingHistory}
                onClick={handleConfirmClearHistory}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-lg shadow-rose-600/25 disabled:opacity-50"
              >
                {isClearingHistory ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>{isClearingHistory ? "Đang xóa..." : "Xác nhận xóa"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Loading Overlay with Backdrop */}
      {busyMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md px-4 transition-all animate-in fade-in duration-200">
          <div className="bg-slate-900/95 border border-slate-700/80 rounded-2xl p-7 shadow-2xl flex flex-col items-center gap-4 max-w-sm w-full text-center relative overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Ambient glowing radial effects */}
            <div className="absolute -top-12 -left-12 w-36 h-36 bg-rose-500/15 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-12 -right-12 w-36 h-36 bg-indigo-500/15 rounded-full blur-3xl pointer-events-none" />

            {/* Spinner with Loader2 */}
            <div className="relative flex items-center justify-center my-1">
              <div className="w-14 h-14 rounded-full border-4 border-slate-800 border-t-rose-500 animate-spin" />
              <Loader2 className="w-6 h-6 text-rose-400 absolute animate-spin" />
            </div>

            {/* Title and Detail */}
            <div className="space-y-1.5 z-10 w-full">
              <h3 className="text-base font-semibold text-white tracking-wide">
                {renderProgress ? "Đang kết xuất video..." : "Đang thực hiện..."}
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed max-w-xs mx-auto font-mono">
                {busyMessage}
              </p>

              {/* Real-time Render Progress Tracker */}
              {renderProgress && (
                <div className="pt-2 space-y-2 w-full">
                  <div className="flex items-center justify-between text-xs font-mono font-bold px-1">
                    <span className="text-emerald-400">
                      {renderProgress.current} / {renderProgress.total} video
                    </span>
                    <span className="text-indigo-400 font-extrabold">
                      {renderProgress.percent}%
                    </span>
                  </div>
                  {renderProgress.name && (
                    <div className="text-[11px] text-slate-400 truncate max-w-xs mx-auto">
                      Đang xử lý: <span className="text-slate-200">{renderProgress.name}</span>
                    </div>
                  )}
                  <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden border border-slate-700/60 p-0.5">
                    <div
                      className="bg-gradient-to-r from-emerald-500 via-teal-500 to-indigo-500 h-full rounded-full transition-all duration-300 shadow-sm shadow-emerald-500/50"
                      style={{
                        width: `${Math.min(100, Math.max(0, renderProgress.percent))}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Default animated progress bar pulse if no renderProgress */}
            {!renderProgress && (
              <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden mt-1">
                <div className="bg-gradient-to-r from-rose-500 via-indigo-500 to-indigo-600 h-full w-full animate-pulse" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Toast Notifications */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 max-w-sm sm:max-w-md w-full pointer-events-none">
        {toasts.map((toast) => {
          const isSuccess = toast.type === "success";
          const isError = toast.type === "error";

          return (
            <div
              key={toast.id}
              className={`pointer-events-auto rounded-xl p-3.5 shadow-2xl border backdrop-blur-md flex items-start gap-3 transition-all transform translate-y-0 animate-in slide-in-from-bottom-5 duration-300 ${
                isSuccess
                  ? "bg-slate-900/95 border-emerald-500/40 text-emerald-100 shadow-emerald-950/40"
                  : isError
                    ? "bg-slate-900/95 border-rose-500/40 text-rose-100 shadow-rose-950/40"
                    : "bg-slate-900/95 border-sky-500/40 text-sky-100 shadow-sky-950/40"
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {isSuccess && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                )}
                {isError && <AlertTriangle className="w-4 h-4 text-rose-400" />}
                {!isSuccess && !isError && (
                  <Info className="w-4 h-4 text-sky-400" />
                )}
              </div>

              <div className="flex-1 text-xs leading-relaxed space-y-0.5 min-w-0">
                <p className="font-semibold text-slate-100">
                  {isSuccess
                    ? "Thành công"
                    : isError
                      ? "Có lỗi xảy ra"
                      : "Thông báo"}
                </p>
                <p className="text-slate-300 text-[11px] whitespace-pre-wrap break-words">
                  {toast.text}
                </p>
              </div>

              <button
                onClick={() => removeToast(toast.id)}
                className="text-slate-400 hover:text-slate-200 transition p-0.5 rounded-lg hover:bg-slate-800 shrink-0"
                title="Đóng thông báo"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
