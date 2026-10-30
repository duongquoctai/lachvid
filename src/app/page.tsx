"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  ResolvedShotSlot,
  Shot,
  SHOT_CATEGORIES,
  ShotCategory,
  VoiceTrack,
} from "@/types/lachvid";
import { CATEGORY_ORDER, recalculateComposedVideo } from "@/lib/planner";
import PreviewPlayer916 from "@/components/PreviewPlayer916";
import IPhoneVideoTrimmer from "@/components/IPhoneVideoTrimmer";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Code2,
  Download,
  Film,
  FlipHorizontal,
  FolderDown,
  FolderOpen,
  FolderSync,
  Info,
  KeyRound,
  Layers,
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
  Trash2,
  Unlock,
  Upload,
  Wand2,
  X,
} from "lucide-react";

export default function LachVidStudioPage() {
  const [mainTab, setMainTab] = useState<"split" | "mix">("split");
  const [state, setState] = useState<ProjectState | null>(null);

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
  const [editingSlotCategory, setEditingSlotCategory] = useState<ShotCategory | null>(null);
  const [activeSlotFocusIndex, setActiveSlotFocusIndex] = useState<number | null>(null);
  const [previewSeekSec, setPreviewSeekSec] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<"full" | "slot">("full");
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);
  const [scrubSourceSec, setScrubSourceSec] = useState<number | null>(null);
  const [playTrigger, setPlayTrigger] = useState<number>(0);

  // Zvid API & Modals
  const [apiKey, setApiKey] = useState<string>("");
  const [hasEnvKey, setHasEnvKey] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<
    Array<{
      id: string;
      type: "info" | "success" | "error";
      text: string;
    }>
  >([]);
  const [showJsonModal, setShowJsonModal] = useState(false);

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

  // Load project state and category library on mount
  useEffect(() => {
    fetch("/api/project")
      .then((r) => r.json())
      .then((data) => {
        if (data.state) {
          setState(data.state);
          setHasEnvKey(Boolean(data.hasEnvApiKey));
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

    fetch("/api/category-library")
      .then((r) => r.json())
      .then((data) => {
        if (data.categoryPools) setCategoryPools(data.categoryPools);
        if (data.multiVoiceTracks) setMultiVoices(data.multiVoiceTracks);
      })
      .catch(() => {});
  }, []);

  const persistState = useCallback(async (nextState: ProjectState) => {
    setState(nextState);
    try {
      await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: nextState }),
      });
    } catch {
      // ignore transient save error
    }
  }, []);

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

  const selectedComposed = useMemo(() => {
    if (!state || state.composedVideos.length === 0) return null;
    return (
      state.composedVideos.find((c) => c.id === selectedComposedId) ||
      state.composedVideos[0]
    );
  }, [state, selectedComposedId]);

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
    setBusyMessage(`Đang tải lên video ${file.name}...`);
    setStatusBanner(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "source");

      const res = await fetch("/api/upload-local", {
        method: "POST",
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
  const handleSplitAtTime = (targetSec: number) => {
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
      targetSec > shotToSplit.begin + 0.3 && targetSec < shotToSplit.end - 0.3
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
  };

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

  const keyActionsRef = useRef({
    handleCategoryChange,
    handleSplitAtTime,
    handleToggleFlipH,
    handleToggleLockFlipH,
    handleStopSlicer,
    handlePlayActiveShot,
    selectedShotId,
    slicerTime,
    isPlayingSlicer,
  });

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: state.sourceVideo.localPath,
          scenes: state.shots,
          categoryMinDurations,
          sessionId: `video_${Date.now().toString(36)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi cắt video");

      // Trigger download
      const a = document.createElement("a");
      a.href = data.zip_download_url;
      a.download = `lachvid_categories_${data.session_id}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setStatusBanner({
        type: "success",
        text: `Đã cắt thành công ${data.total_sliced} clip và tải về file ZIP (chứa sẵn 5 folder OPEN, PRODUCT, TEXTURE, APPLY, END)!`,
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
      // Prompt user to pick a root folder on disk
      const picker = (
        window as unknown as {
          showDirectoryPicker?: (opts: unknown) => Promise<any>;
        }
      ).showDirectoryPicker;
      if (!picker) throw new Error("showDirectoryPicker không khả dụng");
      const rootDirHandle = await picker({ mode: "readwrite" });

      setIsSlicing(true);
      setBusyMessage(
        "Đang cắt các clip và ghi thẳng vào các thư mục trên ổ cứng...",
      );

      const res = await fetch("/api/slice-scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: state.sourceVideo.localPath,
          scenes: state.shots,
          categoryMinDurations,
          sessionId: `video_${Date.now().toString(36)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi cắt video");

      // Write each sliced file directly into the corresponding category subfolder
      let savedCount = 0;
      for (const item of data.files) {
        const catName = item.category.toUpperCase();
        const catDirHandle = await rootDirHandle.getDirectoryHandle(catName, {
          create: true,
        });

        // Fetch file content
        const fileRes = await fetch(item.url);
        if (!fileRes.ok) {
          throw new Error(
            `Lỗi tải video ${item.filename} (HTTP ${fileRes.status})`,
          );
        }
        const blob = await fileRes.blob();
        if (blob.size < 500) {
          throw new Error(
            `File ${item.filename} tải về không hợp lệ (${blob.size} bytes).`,
          );
        }

        const fileHandle = await catDirHandle.getFileHandle(item.filename, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
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
  const handleNextVideo = () => {
    if (!state) return;
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
  // TAB 2 ACTIONS (Trộn Theo Folder Category)
  // ==========================================

  // Master folder upload (reads all subfolders OPEN, PRODUCT, TEXTURE, APPLY, END)
  const handleMasterFolderUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setBusyMessage(`Đang phân loại và nạp ${files.length} file từ thư mục...`);
    setStatusBanner(null);
    try {
      const fd = new FormData();
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
      const res = await fetch("/api/category-library", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi nạp thư mục");

      setCategoryPools(data.categoryPools);
      setStatusBanner({
        type: "success",
        text: `Đã nạp thành công ${data.addedCount} video vào 5 Category!`,
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
    setBusyMessage(
      `Đang nạp ${files.length} video vào ${category.toUpperCase()}...`,
    );
    try {
      const fd = new FormData();
      fd.append("targetCategory", category);
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
      const res = await fetch("/api/category-library", {
        method: "POST",
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
      fd.append("action", "upload_voice");
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
      const res = await fetch("/api/category-library", {
        method: "POST",
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
    fd.append("action", "remove_item");
    fd.append("category", cat);
    fd.append("itemId", itemId);
    const res = await fetch("/api/category-library", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (data.categoryPools) setCategoryPools(data.categoryPools);
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
    try {
      const res = await fetch("/api/plan-mix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryPools,
          diversityConfig: {
            targetCount: targetMixCount,
            minHammingDistance: 3,
            maxShotFrequency: Math.max(2, Math.ceil(targetMixCount / 3)),
            seed: Date.now(),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi tạo tổ hợp");

      setState((prev) =>
        prev
          ? {
              ...prev,
              composedVideos: data.composedVideos,
            }
          : null,
      );
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
      const foundMulti = state.multiVoiceTracks?.find((v) => v.id === targetComp.voiceTrackId);
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

  // Direct FFmpeg Render Single Composed Video
  const handleRenderSingleComposed = async (composed: ComposedVideo) => {
    setBusyMessage(`Đang xuất file MP4 hoàn chỉnh cho ${composed.name}...`);
    try {
      const res = await fetch("/api/render-composed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videos: [composed],
          sessionId: `single_${composed.id}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi render video");

      const file = data.files?.[0];
      if (file?.url) {
        const a = document.createElement("a");
        a.href = file.url;
        a.download = file.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setStatusBanner({
          type: "success",
          text: `Đã xuất thành công ${file.filename} (${file.duration}s)!`,
        });
      }
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
    setBusyMessage(`Đang render ${state.composedVideos.length} video MP4 và đóng gói ZIP...`);
    try {
      const res = await fetch("/api/render-composed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videos: state.composedVideos,
          sessionId: `batch_${Date.now().toString(36)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi render tổ hợp");

      if (data.zip_download_url) {
        const a = document.createElement("a");
        a.href = data.zip_download_url;
        a.download = `lachvid_rendered_${data.session_id}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setStatusBanner({
          type: "success",
          text: `Đã render thành công toàn bộ ${data.total_rendered} video MP4 chuẩn và tải về ZIP!`,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  // Direct FFmpeg Render All Composed Videos (Save directly to disk folder)
  const handleRenderAllDirectToFolder = async () => {
    if (!state?.composedVideos || state.composedVideos.length === 0) {
      setStatusBanner({ type: "error", text: "Chưa có tổ hợp nào để xuất." });
      return;
    }

    if (!("showDirectoryPicker" in window)) {
      setStatusBanner({
        type: "info",
        text: "Trình duyệt chưa hỗ trợ chọn thư mục trực tiếp. Hệ thống tự động chuyển sang tải file .ZIP!",
      });
      await handleRenderAllComposedZip();
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

      setBusyMessage(`Đang render ${state.composedVideos.length} video và ghi thẳng vào ổ cứng...`);

      const res = await fetch("/api/render-composed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videos: state.composedVideos,
          sessionId: `batch_${Date.now().toString(36)}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi khi render tổ hợp");

      let saved = 0;
      for (const item of data.files || []) {
        const fileRes = await fetch(item.url);
        if (!fileRes.ok) continue;
        const blob = await fileRes.blob();
        const fileHandle = await rootDirHandle.getFileHandle(item.filename, {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        saved++;
      }

      setStatusBanner({
        type: "success",
        text: `Tuyệt vời! Đã ghi thẳng ${saved} video MP4 hoàn chỉnh vào thư mục máy tính!`,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  // Zvid Account & Quota Check
  const handleCheckZvidAccount = async () => {
    setBusyMessage("Đang kiểm tra quota Zvid.io...");
    try {
      const res = await fetch("/api/zvid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetch_schema_and_limits",
          apiKey: apiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không kiểm tra được Zvid");
      setState(data.state);
      setStatusBanner({
        type: "success",
        text: `Zvid API key hợp lệ! Hạn mức bộ nhớ: ${(
          data.limits?.maxTotalBytes /
          1024 /
          1024
        ).toFixed(0)} MB.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  // Zvid Lazy Upload & Validate
  const handleLazyUploadAndValidate = async () => {
    setBusyMessage(
      "Đang kiểm tra schema và hạn mức trước khi render (0 Credit)...",
    );
    try {
      const res = await fetch("/api/zvid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "lazy_upload_and_validate",
          apiKey: apiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Validate thất bại");
      setState(data.state);
      setStatusBanner({
        type: "success",
        text: `Đã validate toàn bộ tổ hợp thành công! Sẵn sàng render.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  // Zvid Batch Submit Render
  const handleSubmitBatchRender = async (singleId?: string) => {
    setBusyMessage(
      singleId
        ? "Đang gửi render cho 1 video..."
        : `Đang gửi hàng đợi render ${state?.composedVideos.length || 0} video lên Zvid...`,
    );
    try {
      const res = await fetch("/api/zvid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_submit_render",
          apiKey: apiKey || undefined,
          targetComposedId: singleId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Render thất bại");
      setState(data.state);
      setStatusBanner({
        type: "success",
        text: `Đã đẩy ${data.submittedCount} video vào hàng đợi render Zvid!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusBanner({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header & Two-Tab Navigation */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-rose-500/20">
            <Film className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight flex items-center gap-2">
              <span>LachVid Studio</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                PRO 2.0
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Hệ thống tách video slicer & trộn lách content mỹ phẩm
            </p>
          </div>
        </div>

        {/* The Two Dedicated Workspaces / Tabs */}
        <div className="flex items-center bg-slate-950 p-1.5 rounded-2xl border border-slate-800 shadow-inner">
          <button
            onClick={() => setMainTab("split")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              mainTab === "split"
                ? "bg-rose-500 text-white shadow-md shadow-rose-500/30 scale-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Scissors className="w-4 h-4" />
            <span>Khâu 1: Tách 1 video & slicer studio</span>
          </button>
          <button
            onClick={() => setMainTab("mix")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              mainTab === "mix"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-500/30 scale-100"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Shuffle className="w-4 h-4" />
            <span>Khâu 2: Trộn & ghép video theo folder</span>
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
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold truncate text-white">
                        {state.sourceVideo.name}
                      </span>
                      <span className="font-mono text-emerald-400">
                        {state.sourceVideo.duration.toFixed(1)}s
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-slate-400">
                      <span>
                        {(state.sourceVideo.sizeBytes / 1024 / 1024).toFixed(1)}{" "}
                        MB
                      </span>
                      <span>•</span>
                      <span>
                        {state.sourceVideo.width}x{state.sourceVideo.height}
                      </span>
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
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-indigo-600 hover:from-rose-600 hover:to-indigo-700 text-white text-xs font-bold transition shadow-lg shadow-rose-500/20 disabled:opacity-50 disabled:pointer-events-none"
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

            {/* FULL SLICER STUDIO 2-COLUMN WORKSPACE */}
            {state?.shots && state.shots.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* ======================================================== */}
                {/* LEFT COLUMN (5/12): VIDEO MONITOR 9:16 + TIMELINE RIBBON */}
                {/* ======================================================== */}
                <div className="lg:col-span-5 bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Màn hình duyệt cảnh (Source video monitor)
                    </h3>
                    <span className="text-xs font-mono text-rose-400">
                      {slicerTime.toFixed(1)}s /{" "}
                      {(state.sourceVideo?.duration || 0).toFixed(1)}s
                    </span>
                  </div>

                  {/* 9:16 Video Canvas Player with live effects */}
                  <div className="relative aspect-[9/16] max-h-[380px] mx-auto rounded-xl overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center shadow-2xl">
                    {state.sourceVideo?.localUrl ? (
                      <video
                        ref={slicerVideoRef}
                        src={state.sourceVideo.localUrl}
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
                          className="px-3.5 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-rose-500/20"
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
                          onClick={() => handleMergeWithNext(selectedShotId)}
                          className="px-2.5 py-1.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold"
                          title="Gộp với shot kế tiếp"
                        >
                          Gộp sau
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Interactive Timeline Ribbon */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Thanh timeline phân đoạn (Click để chọn cảnh)</span>
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
                              if (slicerVideoRef.current) {
                                slicerVideoRef.current.currentTime = shot.begin;
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
                                ? "ring-2 ring-white z-10"
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

                {/* ======================================================== */}
                {/* RIGHT COLUMN (7/12): SHOT LIST EDITOR & PER-SHOT INSPECTOR */}
                {/* ======================================================== */}
                <div className="lg:col-span-7 space-y-4">
                  {/* Detailed Shot List Table */}
                  <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <Scissors className="w-4 h-4 text-rose-400" />
                        <span>
                          Danh sách {state.shots.length} cảnh cắt (Chỉnh mốc
                          giây từng 0.1s)
                        </span>
                      </h3>
                      <button
                        onClick={() => {
                          const lastEnd =
                            state.shots[state.shots.length - 1]?.end || 0;
                          const maxDur = state.sourceVideo?.duration || 30;
                          const newBegin =
                            lastEnd < maxDur - 1
                              ? lastEnd
                              : Math.max(0, maxDur - 4);
                          const newShot: Shot = {
                            id: `shot_${Date.now()}`,
                            sourceVideoId: state.sourceVideo?.id || "src_vid",
                            label: `Cảnh #${state.shots.length + 1}`,
                            begin: Math.round(newBegin * 10) / 10,
                            end:
                              Math.round(Math.min(maxDur, newBegin + 4) * 10) /
                              10,
                            category: "product",
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
                          setSelectedShotId(newShot.id);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 transition"
                      >
                        <span>+ Thêm shot thủ công</span>
                      </button>
                    </div>

                    {/* Scrollable Rows of Shots */}
                    <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1">
                      {state.shots.map((shot, idx) => {
                        const isSel = shot.id === selectedShotId;
                        const rawDur = Math.max(0.1, shot.end - shot.begin);
                        const minDur =
                          (shot.category
                            ? categoryMinDurations[shot.category]
                            : null) ?? 3.0;
                        const speed = shot.edits?.speed || 1.0;
                        const effectiveDur = (rawDur / speed).toFixed(1);
                        const isSlowMo = speed < 0.999;
                        return (
                          <div
                            key={shot.id}
                            onClick={() => {
                              setSelectedShotId(shot.id);
                              if (slicerVideoRef.current) {
                                slicerVideoRef.current.currentTime = shot.begin;
                              }
                              setSlicerTime(shot.begin);
                            }}
                            className={`p-2.5 rounded-xl border flex flex-wrap items-center justify-between gap-2 cursor-pointer transition ${
                              isSel
                                ? "bg-slate-800/90 border-rose-500/80 shadow-md shadow-rose-500/10"
                                : "bg-slate-950/60 border-slate-800 hover:border-slate-700"
                            }`}
                          >
                            {/* Number & Label */}
                            <div className="flex items-center gap-2 min-w-[150px] flex-1">
                              <span className="w-5 h-5 rounded-md bg-slate-900 border border-slate-700 text-[10px] font-mono flex items-center justify-center text-slate-400 shrink-0">
                                {idx + 1}
                              </span>
                              <input
                                type="text"
                                value={shot.label}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  const updated = state.shots.map((s) =>
                                    s.id === shot.id
                                      ? { ...s, label: e.target.value }
                                      : s,
                                  );
                                  persistState({ ...state, shots: updated });
                                }}
                                className="bg-transparent text-xs font-semibold text-slate-100 focus:outline-none border-b border-transparent focus:border-rose-500 flex-1 truncate"
                              />
                            </div>

                            {/* Precise Numeric Time Inputs (begin -> end) */}
                            <div
                              className="flex items-center gap-1 text-xs font-mono"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* Begin input & quick button */}
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                value={shot.begin}
                                onChange={(e) =>
                                  handleUpdateShotTime(
                                    shot.id,
                                    "begin",
                                    Number(e.target.value),
                                  )
                                }
                                className="w-14 px-1 py-0.5 rounded bg-slate-900 border border-slate-700 text-center text-slate-200 text-xs"
                              />
                              <button
                                onClick={() =>
                                  handleUpdateShotTime(
                                    shot.id,
                                    "begin",
                                    slicerTime,
                                  )
                                }
                                className="px-1 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[9px] text-slate-400"
                                title="Lấy con trỏ video làm điểm bắt đầu"
                              >
                                [Đầu
                              </button>
                              <span className="text-slate-600">→</span>
                              {/* End input & quick button */}
                              <input
                                type="number"
                                step="0.1"
                                min={shot.begin + 0.2}
                                value={shot.end}
                                onChange={(e) =>
                                  handleUpdateShotTime(
                                    shot.id,
                                    "end",
                                    Number(e.target.value),
                                  )
                                }
                                className="w-14 px-1 py-0.5 rounded bg-slate-900 border border-slate-700 text-center text-slate-200 text-xs"
                              />
                              <button
                                onClick={() =>
                                  handleUpdateShotTime(
                                    shot.id,
                                    "end",
                                    slicerTime,
                                  )
                                }
                                className="px-1 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[9px] text-slate-400"
                                title="Lấy con trỏ video làm điểm kết thúc"
                              >
                                Cuối]
                              </button>
                              <div className="flex flex-col items-end min-w-[70px] text-right ml-1">
                                <span
                                  className={`text-[11px] font-bold font-mono ${
                                    isSlowMo
                                      ? "text-amber-400"
                                      : "text-emerald-400"
                                  }`}
                                  title={`Thời lượng thực tế: ${effectiveDur}s (Tối thiểu yêu cầu: ${minDur}s)`}
                                >
                                  ⏱️ {effectiveDur}s
                                </span>
                                <span className="text-[9px] text-slate-400 font-mono">
                                  {isSlowMo
                                    ? `Slow ${speed.toFixed(2)}x (Gốc ${rawDur.toFixed(1)}s)`
                                    : `Gốc ${rawDur.toFixed(1)}s (≥${minDur}s)`}
                                </span>
                              </div>
                            </div>

                            {/* 1-5 Category Buttons */}
                            <div
                              className="flex items-center gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {SHOT_CATEGORIES.map((c) => {
                                const active = shot.category === c.id;
                                return (
                                  <button
                                    key={c.id}
                                    onClick={() =>
                                      handleCategoryChange(shot.id, c.id)
                                    }
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border transition ${
                                      active
                                        ? c.badgeClass
                                        : "bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300"
                                    }`}
                                    title={`Gán ${c.label} (Phím ${c.hotkey})`}
                                  >
                                    {c.hotkey}.{c.id.slice(0, 3).toUpperCase()}
                                  </button>
                                );
                              })}
                            </div>

                            {/* Row Action Buttons: Play & Delete */}
                            <div
                              className="flex items-center gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={() => handlePlayActiveShot(shot)}
                                className="p-1 rounded bg-slate-800 hover:bg-rose-500 text-slate-300 hover:text-white transition"
                                title="Phát riêng cảnh này"
                              >
                                <Play className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleDeleteShot(shot.id)}
                                className="p-1 text-slate-500 hover:text-rose-400 transition"
                                title="Xoá cảnh này"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* PER-SHOT INSPECTOR (Mirror flipH, Lock text, Speed, Zoom) */}
                  {selectedShot && (
                    <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-rose-400 flex items-center gap-2">
                          <Sliders className="w-4 h-4" />
                          <span>
                            Chỉnh sửa riêng cho cảnh đang chọn: &ldquo;
                            {selectedShot.label}&rdquo;
                          </span>
                        </h4>
                        <span className="text-[11px] font-mono text-slate-400">
                          {selectedShot.begin}s → {selectedShot.end}s (
                          {(selectedShot.end - selectedShot.begin).toFixed(1)}s)
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        {/* Mirror flipH */}
                        <button
                          onClick={() => handleToggleFlipH(selectedShot.id)}
                          className={`p-2.5 rounded-xl border flex items-center justify-between transition ${
                            selectedShot.edits.flipH
                              ? "bg-fuchsia-500/20 border-fuchsia-500/50 text-fuchsia-200"
                              : "bg-slate-950 border-slate-800 text-slate-300"
                          }`}
                        >
                          <span className="flex items-center gap-1.5 font-medium">
                            <FlipHorizontal className="w-4 h-4" />
                            Mirror (flipH)
                          </span>
                          <span className="font-mono text-[11px] font-bold">
                            {selectedShot.edits.flipH ? "ON" : "OFF"}
                          </span>
                        </button>

                        {/* Lock flipH (Keep text readable) */}
                        <button
                          onClick={() => handleToggleLockFlipH(selectedShot.id)}
                          className={`p-2.5 rounded-xl border flex items-center justify-between transition ${
                            selectedShot.edits.lockFlipH
                              ? "bg-amber-500/20 border-amber-500/50 text-amber-200"
                              : "bg-slate-950 border-slate-800 text-slate-300"
                          }`}
                          title="Khoá không cho phép lật ngang nếu cảnh có chữ/tên thương hiệu"
                        >
                          <span className="flex items-center gap-1.5 font-medium">
                            {selectedShot.edits.lockFlipH ? (
                              <Lock className="w-4 h-4 text-amber-400" />
                            ) : (
                              <Unlock className="w-4 h-4 text-slate-500" />
                            )}
                            Khoá chữ (L)
                          </span>
                          <span className="font-mono text-[11px] font-bold">
                            {selectedShot.edits.lockFlipH ? "LOCKED" : "FREE"}
                          </span>
                        </button>

                        {/* Playback Speed */}
                        <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex flex-col justify-between">
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span>Tốc độ (Speed)</span>
                            <span className="font-mono text-slate-200 font-bold">
                              {selectedShot.edits.speed}x
                            </span>
                          </div>
                          <input
                            type="range"
                            min="0.5"
                            max="2.0"
                            step="0.05"
                            value={selectedShot.edits.speed}
                            onChange={(e) =>
                              handleSetSpeed(
                                selectedShot.id,
                                Number(e.target.value),
                              )
                            }
                            className="w-full accent-rose-500 mt-1"
                          />
                        </div>

                        {/* Ken Burns Zoom */}
                        <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex flex-col justify-between">
                          <div className="flex items-center justify-between text-[11px] text-slate-400">
                            <span>Ken Burns zoom</span>
                            <span className="font-mono text-slate-200 font-bold">
                              {typeof selectedShot.edits.zoom === "object"
                                ? `${selectedShot.edits.zoom.depth}x`
                                : selectedShot.edits.zoom
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
                              typeof selectedShot.edits.zoom === "object"
                                ? selectedShot.edits.zoom.depth
                                : selectedShot.edits.zoom
                                  ? 1.2
                                  : 1.0
                            }
                            onChange={(e) => {
                              const depth = Number(e.target.value);
                              handleSetZoom(
                                selectedShot.id,
                                depth <= 1.01 ? false : depth,
                              );
                            }}
                            className="w-full accent-rose-500 mt-1"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Export Action Bar (Save Folder / ZIP) */}
                  <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-bold text-white">
                        Xuất toàn bộ các cảnh đã tinh chỉnh về máy tính
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Cắt siêu tốc bằng FFmpeg, giữ nguyên chất lượng 100%,
                        bảo toàn mốc giây và mirror đã chỉnh
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleSliceAndDownloadZip}
                        disabled={isSlicing}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 transition"
                      >
                        <Download className="w-4 h-4 text-rose-400" />
                        <span>Tải ZIP toàn bộ (5 folder)</span>
                      </button>
                      <button
                        onClick={handleDirectSaveToFolder}
                        disabled={isSlicing}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg shadow-emerald-600/20"
                      >
                        <FolderDown className="w-4 h-4" />
                        <span>Lưu thẳng vào thư mục máy tính</span>
                      </button>
                      <button
                        onClick={handleNextVideo}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/20"
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
            {/* Top Action Bar: Folder Import & Stats */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-bold flex items-center gap-2 text-white">
                    <FolderOpen className="w-5 h-5 text-indigo-400" />
                    <span>Kho video theo 5 category (đã tách từ máy tính)</span>
                  </h2>
                  <p className="text-xs text-slate-400">
                    Chọn thư mục mẹ chứa sẵn 5 folder OPEN, PRODUCT, TEXTURE,
                    APPLY, END hoặc upload riêng từng cột
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => masterFolderInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/20"
                  >
                    <FolderSync className="w-4 h-4" />
                    <span>Chọn thư mục tổng từ máy (tự phân 5 cột)</span>
                  </button>
                  <button
                    onClick={async () => {
                      const fd = new FormData();
                      fd.append("action", "clear_all");
                      const res = await fetch("/api/category-library", {
                        method: "POST",
                        body: fd,
                      });
                      const d = await res.json();
                      if (d.categoryPools) setCategoryPools(d.categoryPools);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-rose-500/20 hover:text-rose-300 text-xs font-semibold text-slate-300 border border-slate-700 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Xoá trắng kho</span>
                  </button>
                </div>
              </div>

              {/* 5 Category Columns */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
                {CATEGORY_ORDER.map((catKey) => {
                  const meta = SHOT_CATEGORIES.find((c) => c.id === catKey);
                  const items = categoryPools[catKey] || [];
                  return (
                    <div
                      key={catKey}
                      className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between space-y-3 min-h-[220px]"
                    >
                      <div className="flex items-center justify-between">
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

                      {/* Items List */}
                      <div className="flex-1 space-y-1.5 max-h-36 overflow-y-auto pr-1">
                        {items.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-center p-3 text-[11px] text-slate-500">
                            Chưa có clip nào
                          </div>
                        ) : (
                          items.map((it) => (
                            <div
                              key={it.id}
                              className="p-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] flex items-center justify-between group"
                            >
                              <span
                                className="truncate max-w-[100px] text-slate-300 flex items-center gap-1"
                                title={it.name}
                              >
                                {it.lockFlipH && (
                                  <Lock className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                                )}
                                <span>{it.name}</span>
                              </span>
                              <div className="flex items-center gap-1">
                                <span className="font-mono text-slate-500">
                                  {it.duration.toFixed(1)}s
                                </span>
                                <button
                                  onClick={() =>
                                    handleRemoveCategoryItem(catKey, it.id)
                                  }
                                  className="text-slate-500 hover:text-rose-400 ml-1 opacity-0 group-hover:opacity-100 transition"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>

                      {/* Upload Button for this Column */}
                      <button
                        onClick={() =>
                          categoryInputRefs.current[catKey]?.click()
                        }
                        className="w-full py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-semibold text-slate-300 flex items-center justify-center gap-1 transition"
                      >
                        <Plus className="w-3 h-3 text-rose-400" />
                        <span>Thêm clip</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Mixer Settings: Video Count, Multi-Voice */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
              {/* Output Count */}
              <div className="md:col-span-4 space-y-3">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Clock className="w-4 h-4 text-rose-400" />
                  <span>Số lượng output</span>
                </h3>
                <div>
                  <label className="text-[11px] text-slate-400 block mb-1">
                    Số video muốn tạo:
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={targetMixCount}
                    onChange={(e) =>
                      setTargetMixCount(Number(e.target.value))
                    }
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-center text-white focus:outline-none focus:border-rose-500"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    Mỗi video tự do thời lượng; bạn có thể chỉnh từng cảnh bằng tay.
                  </p>
                </div>
              </div>

              {/* Multi-Voice Section */}
              <div className="md:col-span-5 space-y-3 border-y md:border-y-0 md:border-x border-slate-800 py-4 md:py-0 md:px-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Mic className="w-4 h-4 text-indigo-400" />
                    <span>Lồng voice (tùy chọn)</span>
                  </h3>
                  <button
                    onClick={() => voiceInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-semibold text-slate-200 border border-slate-700"
                  >
                    <Upload className="w-3 h-3 text-indigo-400" />
                    <span>+ Thêm voice MP3</span>
                  </button>
                </div>
                <div className="text-xs text-slate-400 flex items-center gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="voiceMode"
                      checked={mixVoiceMode === "none"}
                      onChange={() => setMixVoiceMode("none")}
                      className="accent-indigo-500"
                    />
                    <span>Không lồng voice</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="voiceMode"
                      checked={mixVoiceMode === "rotate"}
                      onChange={() => setMixVoiceMode("rotate")}
                      className="accent-indigo-500"
                    />
                    <span>Xoay vòng {multiVoices.length} voice</span>
                  </label>
                </div>
                {multiVoices.length > 0 && mixVoiceMode === "rotate" && (
                  <div className="flex flex-wrap gap-1.5 max-h-16 overflow-y-auto">
                    {multiVoices.map((v) => (
                      <span
                        key={v.id}
                        className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 truncate max-w-[130px]"
                        title={v.name}
                      >
                        🎵 {v.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Mix Button */}
              <div className="md:col-span-3 flex flex-col justify-center items-center">
                <button
                  onClick={handlePlanDiverseMix}
                  className="w-full py-4 rounded-2xl bg-gradient-to-r from-rose-500 via-pink-500 to-indigo-600 hover:opacity-95 text-white font-extrabold text-sm shadow-xl shadow-rose-500/25 flex items-center justify-center gap-2 transition"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
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
                        Click vào cảnh (OPEN, PRODUCT...) để chỉnh tốc độ, cắt giây, lật gương
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleRenderAllComposedZip}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition"
                        title="Render toàn bộ video bằng FFmpeg và nén ZIP tải về máy"
                      >
                        <Download className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Tải ZIP toàn bộ MP4</span>
                      </button>
                      <button
                        onClick={handleRenderAllDirectToFolder}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition shadow-md shadow-indigo-600/20"
                        title="Render và lưu thẳng toàn bộ file MP4 vào thư mục máy tính"
                      >
                        <FolderDown className="w-3.5 h-3.5" />
                        <span>Lưu thẳng vào máy tính</span>
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
                                  setSelectedComposedId(comp.id);
                                  setEditingSlotCategory(null);
                                  setActiveSlotFocusIndex(null);
                                  setPreviewMode("full");
                                  setPlayTrigger((prev) => prev + 1);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold shadow-md shadow-emerald-600/20 transition"
                                title="Xem trước toàn bộ video (5 cảnh)"
                              >
                                <Play className="w-3 h-3 fill-current" />
                                <span>Phát</span>
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
                                    setPreviewMode(willBeActive ? "slot" : "full");
                                    setPlayTrigger((prev) => prev + 1);
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
                                    (Gốc: {(activeSlot.originalVideoEnd || activeSlot.videoEnd).toFixed(1)}s)
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
                                    <span>{activeSlot.flipH ? "Đang lật gương" : "Lật gương"}</span>
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
                                      activeSlot.videoEnd - activeSlot.videoBegin
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
                                      setPlayTrigger((prev) => prev + 1);
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
                    {selectedComposed && (
                      <button
                        onClick={() => setShowJsonModal(true)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700"
                      >
                        <Code2 className="w-3.5 h-3.5 text-rose-400" />
                        <span>Zvid JSON</span>
                      </button>
                    )}
                  </div>

                  {selectedComposed ? (
                    <PreviewPlayer916
                      key={selectedComposed.id}
                      composed={selectedComposed}
                      sourceVideo={state.sourceVideo}
                      voiceTrack={
                        selectedComposed.voiceTrackId ? state.voiceTrack : null
                      }
                      enableVoice={mixVoiceMode === "rotate"}
                      previewMode={previewMode}
                      isolatedSlotIndex={
                        previewMode === "slot" && typeof activeSlotFocusIndex === "number"
                          ? activeSlotFocusIndex
                          : null
                      }
                      isScrubbing={isScrubbing}
                      scrubSourceSec={scrubSourceSec}
                      playTrigger={playTrigger}
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

            {/* Zvid Paid API Cloud Render Queue Section */}
            {state?.composedVideos && state.composedVideos.length > 0 && (
              <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-bold flex items-center gap-2 text-white">
                    <KeyRound className="w-4 h-4 text-rose-400" />
                    <span>Render hàng loạt qua Zvid paid API cloud</span>
                  </h3>
                  {state.zvidUploadUsage && (
                    <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300">
                      Zvid Storage:{" "}
                      {(state.zvidUploadUsage.usedBytes / 1024 / 1024).toFixed(
                        1,
                      )}{" "}
                      MB /{" "}
                      {(
                        state.zvidUploadUsage.maxTotalBytes /
                        1024 /
                        1024
                      ).toFixed(0)}{" "}
                      MB
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    placeholder={
                      hasEnvKey
                        ? "Đã có ZVID_API_KEY trong môi trường (Nhập để ghi đè)"
                        : "Nhập Zvid API Key (x-api-key từ app.zvid.io/api-keys)..."
                    }
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="flex-1 min-w-[240px] px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-slate-100 focus:outline-none focus:border-rose-500"
                  />
                  <button
                    onClick={handleCheckZvidAccount}
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 transition"
                  >
                    Kiểm tra hạn mức Zvid
                  </button>
                  <button
                    onClick={handleLazyUploadAndValidate}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-500/40 text-xs font-semibold transition"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>Validate (0 credit)</span>
                  </button>
                  <button
                    onClick={() => handleSubmitBatchRender()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold transition shadow-lg shadow-rose-500/20"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Render cả lô ({state.composedVideos.length})</span>
                  </button>
                </div>

                {/* Render Queue Table */}
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {state.composedVideos.map((comp, idx) => (
                    <div
                      key={comp.id}
                      className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">
                            #{idx + 1} — {comp.name}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">
                            ({comp.finalDuration.toFixed(1)}s •{" "}
                            {comp.validation?.creditsRequired ??
                              Math.ceil(comp.finalDuration)}{" "}
                            credits)
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">
                          jobId: {comp.jobId}
                        </div>
                        {comp.failedReason && (
                          <div className="text-[11px] text-rose-400">
                            Lỗi: {comp.failedReason}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                            comp.renderState === "completed"
                              ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                              : comp.renderState === "validated"
                                ? "bg-sky-500/20 text-sky-300 border-sky-500/40"
                                : comp.renderState === "queued" ||
                                    comp.renderState === "active"
                                  ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                                  : comp.renderState === "failed" ||
                                      comp.renderState === "ValidationFailed"
                                    ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                                    : "bg-slate-800 text-slate-400 border-slate-700"
                          }`}
                        >
                          {comp.renderState.toUpperCase()}
                          {comp.renderState === "active"
                            ? ` (${comp.progress}%)`
                            : ""}
                        </span>

                        {comp.renderState === "completed" &&
                        (comp.localOutputUrl || comp.remoteResultUrl) ? (
                          <a
                            href={
                              comp.localOutputUrl || comp.remoteResultUrl || "#"
                            }
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold text-xs hover:bg-emerald-400 transition"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Tải MP4</span>
                          </a>
                        ) : (
                          <button
                            onClick={() => handleSubmitBatchRender(comp.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-500 hover:text-white text-slate-200 text-xs transition"
                          >
                            <Play className="w-3 h-3" />
                            <span>Render lẻ</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Zvid Inline Payload JSON Inspector Modal */}
      {showJsonModal && selectedComposed && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Zvid.io inline renderPayload — {selectedComposed.name}
                </h3>
                <p className="text-xs text-slate-400">
                  Chuẩn schema `POST /api/render/validate/api-key` & `POST
                  /api/render/api-key` (jobId: {selectedComposed.jobId})
                </p>
              </div>
              <button
                onClick={() => setShowJsonModal(false)}
                className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
              >
                Đóng
              </button>
            </div>
            <pre className="p-5 text-xs font-mono text-emerald-300 overflow-auto flex-1 bg-slate-950">
              {JSON.stringify(
                {
                  jobId: selectedComposed.jobId,
                  payload: selectedComposed.zvidPayload,
                },
                null,
                2,
              )}
            </pre>
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
            <div className="space-y-1.5 z-10">
              <h3 className="text-base font-semibold text-white tracking-wide">
                Đang thực hiện...
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed max-w-xs font-mono">
                {busyMessage}
              </p>
            </div>

            {/* Animated progress bar pulse */}
            <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden mt-1">
              <div className="bg-gradient-to-r from-rose-500 via-purple-500 to-indigo-500 h-full w-full animate-pulse" />
            </div>
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
