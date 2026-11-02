"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  ComposedVideo,
  SHOT_CATEGORIES,
  SourceVideo,
  VoiceTrack,
} from "@/types/lachvid";
import { Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";

// In-memory Blob URL cache for drive streams (0ms latency, zero server disk)
const driveBlobCache = new Map<string, string>();

interface PreviewPlayer916Props {
  composed: ComposedVideo;
  sourceVideo: SourceVideo | null;
  voiceTrack?: VoiceTrack | null;
  enableVoice?: boolean;
  activeSlotFocusIndex?: number | null;
  onSlotFocusChange?: (index: number) => void;
  seekTimelineSec?: number | null;
  previewMode?: "full" | "slot";
  isolatedSlotIndex?: number | null;
  isScrubbing?: boolean;
  scrubSourceSec?: number | null;
  playTrigger?: number;
}

export default function PreviewPlayer916({
  composed,
  sourceVideo,
  voiceTrack,
  enableVoice = true,
  activeSlotFocusIndex,
  onSlotFocusChange,
  seekTimelineSec,
  previewMode = "full",
  isolatedSlotIndex,
  isScrubbing = false,
  scrubSourceSec,
  playTrigger,
}: PreviewPlayer916Props) {
  // Dual Video Buffering (Ping-Pong A & B)
  const videoRefA = useRef<HTMLVideoElement | null>(null);
  const videoRefB = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const preloadedSlotIndexRef = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [timelineSec, setTimelineSec] = useState(0);
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  const [slotCurrentSec, setSlotCurrentSec] = useState(0);
  const [mutedVoice, setMutedVoice] = useState(false);

  const timelineSecRef = useRef(0);
  const activeSlotIndexRef = useRef(0);
  const isPlayingRef = useRef(true);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const totalDuration = Math.max(0.5, composed.finalDuration || 20);

  const isSlotMode =
    previewMode === "slot" &&
    typeof isolatedSlotIndex === "number" &&
    isolatedSlotIndex >= 0 &&
    isolatedSlotIndex < composed.slots.length;

  const isoSlot = isSlotMode && typeof isolatedSlotIndex === "number"
    ? composed.slots[isolatedSlotIndex]
    : null;

  const currentSlot = isSlotMode && isoSlot
    ? isoSlot
    : composed.slots[activeSlotIndex] || composed.slots[0];

  const catMeta = SHOT_CATEGORIES.find((c) => c.id === currentSlot?.category);

  // In full mode: even slots use Video A, odd slots use Video B.
  // In slot mode: always use Video A.
  const isVideoAActive = isSlotMode ? true : activeSlotIndex % 2 === 0;

  const [, setBlobReadyTick] = useState(0);

  // Background fetch Drive stream into browser Blob URL (0ms latency, zero server disk)
  useEffect(() => {
    let active = true;
    for (const slot of composed.slots) {
      const url = slot.localUrl;
      if (url && url.startsWith("/api/drive-stream/") && !driveBlobCache.has(url)) {
        fetch(url)
          .then((res) => (res.ok ? res.blob() : null))
          .then((blob) => {
            if (blob && active) {
              const blobUrl = URL.createObjectURL(blob);
              driveBlobCache.set(url, blobUrl);
              setBlobReadyTick((t) => t + 1);
            }
          })
          .catch(() => {});
      }
    }
    return () => {
      active = false;
    };
  }, [composed]);

  const getSlotMediaUrl = useCallback(
    (slot?: (typeof composed)["slots"][0]) => {
      const raw = slot?.localUrl || sourceVideo?.localUrl || "";
      if (raw && driveBlobCache.has(raw)) {
        return driveBlobCache.get(raw)!;
      }
      return raw;
    },
    [sourceVideo?.localUrl]
  );

  // Pre-seek upcoming slot into the idle background video (full mode)
  const preloadNextSlot = useCallback(
    (currentIndex: number) => {
      if (isSlotMode) return;
      const nextIndex = currentIndex + 1;
      if (nextIndex >= composed.slots.length) return;
      if (preloadedSlotIndexRef.current === nextIndex) return;

      const nextSlot = composed.slots[nextIndex];
      const targetPreloadVideo =
        nextIndex % 2 === 0 ? videoRefA.current : videoRefB.current;
      const mediaUrl = getSlotMediaUrl(nextSlot);
      if (!targetPreloadVideo || !mediaUrl) return;

      targetPreloadVideo.pause();
      if (
        !targetPreloadVideo.src ||
        (!targetPreloadVideo.src.endsWith(mediaUrl) &&
          targetPreloadVideo.src !== mediaUrl)
      ) {
        targetPreloadVideo.src = mediaUrl;
      }
      targetPreloadVideo.currentTime = nextSlot.videoBegin;
      targetPreloadVideo.playbackRate = Math.min(
        4,
        Math.max(0.25, nextSlot.speed || 1)
      );
      preloadedSlotIndexRef.current = nextIndex;
    },
    [composed, getSlotMediaUrl, isSlotMode]
  );

  // Jump to specific point when user scrubs / clicks slot mini-bars in full mode
  const handleSeekTimeline = useCallback((targetSec: number) => {
    const clamped = Math.max(0, Math.min(totalDuration, targetSec));
    timelineSecRef.current = clamped;
    setTimelineSec(clamped);

    let targetIndex = 0;
    for (let i = composed.slots.length - 1; i >= 0; i--) {
      const s = composed.slots[i];
      if (clamped >= s.enterBegin && clamped <= s.exitEnd + 0.05) {
        targetIndex = i;
        break;
      }
    }

    activeSlotIndexRef.current = targetIndex;
    setActiveSlotIndex(targetIndex);

    const slot = composed.slots[targetIndex];
    if (!slot) return;

    const elapsed = Math.max(0, clamped - slot.enterBegin);
    const targetSourceTime = Math.min(
      slot.videoEnd,
      slot.videoBegin + elapsed * (slot.speed || 1)
    );

    const isA = targetIndex % 2 === 0;
    const targetVid = isA ? videoRefA.current : videoRefB.current;
    if (targetVid) {
      targetVid.currentTime = targetSourceTime;
      targetVid.playbackRate = Math.min(4, Math.max(0.25, slot.speed || 1));
      if (isPlayingRef.current) {
        targetVid.play().catch(() => {});
      }
    }

    if (audioRef.current && enableVoice && voiceTrack?.localUrl) {
      audioRef.current.currentTime = clamped;
    }

    preloadedSlotIndexRef.current = null;
    preloadNextSlot(targetIndex);
  }, [composed.slots, enableVoice, preloadNextSlot, totalDuration, voiceTrack?.localUrl]);

  // Handle playTrigger or mode changes
  const lastPlayTriggerRef = useRef<number | undefined>(playTrigger);
  const handleSeekRef = useRef(handleSeekTimeline);
  useEffect(() => {
    handleSeekRef.current = handleSeekTimeline;
  });

  useEffect(() => {
    if (playTrigger !== undefined && playTrigger !== lastPlayTriggerRef.current) {
      lastPlayTriggerRef.current = playTrigger;
      const timer = setTimeout(() => {
        setIsPlaying(true);
        if (isSlotMode && isoSlot && videoRefA.current) {
          videoRefA.current.currentTime = isoSlot.videoBegin;
          videoRefA.current.playbackRate = Math.min(4, Math.max(0.25, isoSlot.speed || 1));
          videoRefA.current.play().catch(() => {});
        } else if (!isSlotMode) {
          handleSeekRef.current(0);
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [playTrigger, isSlotMode, isoSlot]);

  // Initial setup: Mount / Composed change
  useEffect(() => {
    preloadedSlotIndexRef.current = null;
    timelineSecRef.current = 0;
    activeSlotIndexRef.current = 0;

    const vidA = videoRefA.current;
    const vidB = videoRefB.current;

    if (isSlotMode && isoSlot) {
      const url = getSlotMediaUrl(isoSlot);
      if (vidA && url) {
        if (!vidA.src || (!vidA.src.endsWith(url) && vidA.src !== url)) {
          vidA.src = url;
        }
        vidA.currentTime = isoSlot.videoBegin;
        vidA.playbackRate = Math.min(4, Math.max(0.25, isoSlot.speed || 1));
        vidA.play().catch(() => {});
      }
      if (vidB) vidB.pause();
      if (audioRef.current) audioRef.current.pause();
      return;
    }

    if (!composed.slots[0]) return;
    const slot0 = composed.slots[0];
    const slot1 = composed.slots[1];
    const url0 = getSlotMediaUrl(slot0);
    const url1 = getSlotMediaUrl(slot1);

    if (vidA && url0) {
      if (!vidA.src || (!vidA.src.endsWith(url0) && vidA.src !== url0)) {
        vidA.src = url0;
      }
      vidA.currentTime = slot0.videoBegin;
      vidA.playbackRate = Math.min(4, Math.max(0.25, slot0.speed || 1));
    }
    if (vidB && slot1 && url1) {
      if (!vidB.src || (!vidB.src.endsWith(url1) && vidB.src !== url1)) {
        vidB.src = url1;
      }
      vidB.currentTime = slot1.videoBegin;
      vidB.playbackRate = Math.min(4, Math.max(0.25, slot1.speed || 1));
      preloadedSlotIndexRef.current = 1;
    }
  }, [composed, getSlotMediaUrl, isSlotMode, isoSlot]);

  // Scrubbing in slot mode: live seek video to scrubSourceSec
  useEffect(() => {
    if (isSlotMode && isScrubbing && typeof scrubSourceSec === "number" && !isNaN(scrubSourceSec)) {
      if (videoRefA.current) {
        videoRefA.current.pause();
        videoRefA.current.currentTime = scrubSourceSec;
      }
      const timer = setTimeout(() => {
        setSlotCurrentSec(scrubSourceSec);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isSlotMode, isScrubbing, scrubSourceSec]);

  // External seekTimelineSec for full mode
  useEffect(() => {
    if (!isSlotMode && typeof seekTimelineSec === "number" && !isNaN(seekTimelineSec)) {
      const timer = setTimeout(() => {
        handleSeekRef.current(seekTimelineSec);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [seekTimelineSec, isSlotMode]);

  // Main high-performance playback tick loop
  useEffect(() => {
    if (!isPlaying || (isSlotMode && isScrubbing)) {
      videoRefA.current?.pause();
      videoRefB.current?.pause();
      audioRef.current?.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = null;
      return;
    }

    // SLOT MODE: Loop isolated slot
    if (isSlotMode && isoSlot) {
      const vidA = videoRefA.current;
      const mediaUrl = getSlotMediaUrl(isoSlot);
      if (vidA && mediaUrl) {
        if (!vidA.src || (!vidA.src.endsWith(mediaUrl) && vidA.src !== mediaUrl)) {
          vidA.src = mediaUrl;
        }
        vidA.playbackRate = Math.min(4, Math.max(0.25, isoSlot.speed || 1));
        if (vidA.currentTime < isoSlot.videoBegin - 0.05 || vidA.currentTime >= isoSlot.videoEnd - 0.05) {
          vidA.currentTime = isoSlot.videoBegin;
        }
        vidA.play().catch(() => {});
      }
      videoRefB.current?.pause();
      audioRef.current?.pause();

      const tickSlot = () => {
        if (!isPlayingRef.current) return;
        if (vidA) {
          const curTime = vidA.currentTime;
          setSlotCurrentSec(curTime);
          if (curTime >= isoSlot.videoEnd - 0.05 || curTime < isoSlot.videoBegin - 0.05) {
            vidA.currentTime = isoSlot.videoBegin;
            vidA.play().catch(() => {});
          }
        }
        rafRef.current = requestAnimationFrame(tickSlot);
      };

      rafRef.current = requestAnimationFrame(tickSlot);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }

    // FULL MODE: Ping-pong playback across all slots
    const currentSlotIdx = activeSlotIndexRef.current;
    const isA = currentSlotIdx % 2 === 0;
    const currentVid = isA ? videoRefA.current : videoRefB.current;
    const slot = composed.slots[currentSlotIdx];
    if (currentVid && slot && sourceVideo?.localUrl) {
      currentVid.playbackRate = Math.min(4, Math.max(0.25, slot.speed || 1));
      currentVid.play().catch(() => {});
    }

    if (audioRef.current && enableVoice && voiceTrack?.localUrl) {
      if (Math.abs(audioRef.current.currentTime - timelineSecRef.current) > 0.3) {
        audioRef.current.currentTime = timelineSecRef.current;
      }
      audioRef.current.play().catch(() => {});
    }

    const tick = (now: number) => {
      if (!isPlayingRef.current) return;
      if (lastTickRef.current == null) {
        lastTickRef.current = now;
      }
      const delta = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      let nextSec = timelineSecRef.current + delta;
      if (nextSec >= totalDuration) {
        nextSec = 0;
        timelineSecRef.current = 0;
        activeSlotIndexRef.current = 0;
        setTimelineSec(0);
        setActiveSlotIndex(0);

        if (videoRefA.current && composed.slots[0]) {
          videoRefA.current.currentTime = composed.slots[0].videoBegin;
          videoRefA.current.playbackRate = Math.min(4, Math.max(0.25, composed.slots[0].speed || 1));
          videoRefA.current.play().catch(() => {});
        }
        if (videoRefB.current) {
          videoRefB.current.pause();
          if (composed.slots[1]) {
            videoRefB.current.currentTime = composed.slots[1].videoBegin;
            videoRefB.current.playbackRate = Math.min(4, Math.max(0.25, composed.slots[1].speed || 1));
            preloadedSlotIndexRef.current = 1;
          }
        }
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      timelineSecRef.current = nextSec;
      setTimelineSec(nextSec);

      let newSlotIdx = 0;
      for (let i = composed.slots.length - 1; i >= 0; i--) {
        const s = composed.slots[i];
        if (nextSec >= s.enterBegin && nextSec <= s.exitEnd + 0.05) {
          newSlotIdx = i;
          break;
        }
      }

      if (newSlotIdx !== activeSlotIndexRef.current) {
        activeSlotIndexRef.current = newSlotIdx;
        setActiveSlotIndex(newSlotIdx);

        const newIsA = newSlotIdx % 2 === 0;
        const nowActiveVid = newIsA ? videoRefA.current : videoRefB.current;
        const nowIdleVid = newIsA ? videoRefB.current : videoRefA.current;
        const newSlot = composed.slots[newSlotIdx];

        if (nowActiveVid && newSlot) {
          nowActiveVid.playbackRate = Math.min(4, Math.max(0.25, newSlot.speed || 1));
          nowActiveVid.play().catch(() => {});
        }
        if (nowIdleVid) {
          nowIdleVid.pause();
        }

        preloadNextSlot(newSlotIdx);
      }

      if (audioRef.current && enableVoice && voiceTrack?.localUrl) {
        if (Math.abs(audioRef.current.currentTime - nextSec) > 0.4) {
          audioRef.current.currentTime = nextSec;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [
    isPlaying,
    isSlotMode,
    isScrubbing,
    isoSlot,
    totalDuration,
    enableVoice,
    composed.slots,
    sourceVideo?.localUrl,
    voiceTrack?.localUrl,
    preloadNextSlot,
    getSlotMediaUrl,
  ]);

  // Compute live CSS transform & filter for the active or isolated slot
  const slotDuration = isSlotMode && isoSlot
    ? Math.max(0.2, (isoSlot.videoEnd - isoSlot.videoBegin) / (isoSlot.speed || 1))
    : Math.max(0.2, (currentSlot?.exitEnd || 1) - (currentSlot?.enterBegin || 0));

  const slotProgress = isSlotMode && isoSlot
    ? Math.min(1, Math.max(0, (slotCurrentSec - isoSlot.videoBegin) / Math.max(0.1, isoSlot.videoEnd - isoSlot.videoBegin)))
    : Math.min(1, Math.max(0, (timelineSec - (currentSlot?.enterBegin || 0)) / slotDuration));

  let zoomScale = 1;
  if (currentSlot?.zoom) {
    const targetDepth =
      typeof currentSlot.zoom === "object" && currentSlot.zoom.depth
        ? currentSlot.zoom.depth
        : 1.2;
    zoomScale = 1 + (targetDepth - 1) * slotProgress;
  }

  const flipScaleX = currentSlot?.flipH ? -1 : 1;
  const f = currentSlot?.filter;
  const brightness = 1 + (f?.brightness || 0) / 100;
  const contrast = 1 + (f?.contrast || 0) / 100;
  const saturate = 1 + (f?.saturate || 0) / 100;
  const cssFilter = `brightness(${brightness.toFixed(2)}) contrast(${contrast.toFixed(
    2
  )}) saturate(${saturate.toFixed(2)})`;

  return (
    <div className="flex flex-col items-center">
      {/* 9:16 Vertical Phone Frame */}
      <div className="relative w-[270px] h-[480px] rounded-2xl overflow-hidden bg-slate-950 border-2 border-slate-800 shadow-2xl flex flex-col justify-between">
        {/* Top Overlay: Active Category / Mode & Transform Badges */}
        <div className="relative z-20 p-3 flex items-center justify-between bg-gradient-to-b from-black/80 via-black/30 to-transparent">
          {isSlotMode && isoSlot ? (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              <span
                className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border shadow-sm ${
                  catMeta?.badgeClass || "bg-rose-500/30 text-rose-200 border-rose-500/50"
                }`}
              >
                Cảnh {isoSlot.category.toUpperCase()} (Xem riêng)
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                Toàn bộ video (5 cảnh)
              </span>
            </div>
          )}

          <div className="flex items-center gap-1.5 text-[10px] font-mono">
            {currentSlot?.flipH && (
              <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/30 text-fuchsia-200 border border-fuchsia-500/40">
                MIRROR
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-slate-800/90 text-slate-300">
              {currentSlot?.speed}x
            </span>
          </div>
        </div>

        {/* Video Elements */}
        <div className="absolute inset-0 overflow-hidden flex items-center justify-center bg-black">
          {sourceVideo?.localUrl || composed.slots.some((s) => s.localUrl) ? (
            <>
              {/* Video Element A */}
              <video
                ref={videoRefA}
                src={getSlotMediaUrl(isSlotMode && isoSlot ? isoSlot : composed.slots[0])}
                muted
                playsInline
                preload="auto"
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-100 ${
                  isVideoAActive ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
                }`}
                style={{
                  transform: isVideoAActive
                    ? `scaleX(${flipScaleX * zoomScale}) scaleY(${zoomScale})`
                    : undefined,
                  filter: isVideoAActive ? cssFilter : undefined,
                }}
              />

              {/* Video Element B (Full mode only) */}
              {!isSlotMode && (
                <video
                  ref={videoRefB}
                  src={getSlotMediaUrl(composed.slots[1])}
                  muted
                  playsInline
                  preload="auto"
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-100 ${
                    !isVideoAActive ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
                  }`}
                  style={{
                    transform: !isVideoAActive
                      ? `scaleX(${flipScaleX * zoomScale}) scaleY(${zoomScale})`
                      : undefined,
                    filter: !isVideoAActive ? cssFilter : undefined,
                  }}
                />
              )}
            </>
          ) : (
            <div
              className="w-full h-full flex flex-col items-center justify-center p-5 text-center transition-all duration-150"
              style={{
                transform: `scaleX(${flipScaleX * zoomScale}) scaleY(${zoomScale})`,
                filter: cssFilter,
                background:
                  "radial-gradient(circle at 50% 35%, rgba(244,63,94,0.22), rgba(15,23,42,0.95))",
              }}
            >
              <div className="text-xs uppercase tracking-widest text-slate-400 mb-2">
                Simulated 9:16
              </div>
              <div className="text-sm font-bold text-white mb-1 px-2">
                {currentSlot?.shotLabel}
              </div>
              <div className="text-xs text-slate-400 font-mono">
                Source: {currentSlot?.videoBegin.toFixed(1)}s →{" "}
                {currentSlot?.videoEnd.toFixed(1)}s
              </div>
            </div>
          )}
        </div>

        {/* Optional Audio Element for Voice Preview (only active in full mode) */}
        {!isSlotMode && enableVoice && voiceTrack?.localUrl && (
          <audio
            ref={audioRef}
            src={voiceTrack.localUrl}
            muted={mutedVoice}
          />
        )}

        {/* Bottom Overlay */}
        <div className="relative z-20 p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent space-y-2">
          {/* Slot mode vs Full mode title & timeline range */}
          {isSlotMode && isoSlot ? (
            <div className="flex items-center justify-between text-[11px] text-slate-200">
              <span className="font-medium truncate max-w-[160px] text-rose-300">
                {isoSlot.shotLabel}
              </span>
              <span className="font-mono text-[10px] text-amber-300 font-bold">
                Cắt: {isoSlot.videoBegin.toFixed(1)}s–{isoSlot.videoEnd.toFixed(1)}s
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px] text-slate-200">
              <span className="font-medium truncate max-w-[170px]">
                {currentSlot?.shotLabel}
              </span>
              <span className="font-mono text-[10px] text-slate-400">
                {currentSlot?.videoBegin.toFixed(1)}s–{currentSlot?.videoEnd.toFixed(1)}s
              </span>
            </div>
          )}

          {/* Progress Bar: Single bar for Slot Mode, 5-segment for Full Mode */}
          {isSlotMode && isoSlot ? (
            <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all duration-75"
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(
                      100,
                      ((slotCurrentSec - isoSlot.videoBegin) /
                        Math.max(0.1, isoSlot.videoEnd - isoSlot.videoBegin)) *
                        100
                    )
                  )}%`,
                }}
              />
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-1">
              {composed.slots.map((slot, idx) => {
                const sDur = Math.max(0.1, slot.exitEnd - slot.enterBegin);
                const fillPct =
                  timelineSec <= slot.enterBegin
                    ? 0
                    : timelineSec >= slot.exitEnd
                    ? 100
                    : ((timelineSec - slot.enterBegin) / sDur) * 100;
                return (
                  <button
                    key={`${slot.category}_${idx}`}
                    onClick={() => {
                      handleSeekTimeline(slot.enterBegin + 0.01);
                    }}
                    title={`Nhảy tới ${slot.category.toUpperCase()} (${slot.enterBegin}s - ${slot.exitEnd}s)`}
                    className="h-1.5 rounded-full bg-white/20 overflow-hidden text-left"
                  >
                    <div
                      className="h-full bg-rose-400 transition-all duration-75"
                      style={{ width: `${fillPct}%` }}
                    />
                  </button>
                );
              })}
            </div>
          )}

          {/* Controls Bar */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  if (isPlaying) {
                    setIsPlaying(false);
                  } else {
                    setIsPlaying(true);
                    if (isSlotMode && isoSlot && videoRefA.current) {
                      videoRefA.current.play().catch(() => {});
                    }
                  }
                }}
                className="p-1.5 rounded-lg bg-white text-slate-950 hover:bg-rose-100 transition shadow"
                title={isPlaying ? "Tạm dừng" : "Phát"}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>

              <button
                onClick={() => {
                  if (isSlotMode && isoSlot && videoRefA.current) {
                    videoRefA.current.currentTime = isoSlot.videoBegin;
                    setSlotCurrentSec(isoSlot.videoBegin);
                    videoRefA.current.play().catch(() => {});
                    setIsPlaying(true);
                  } else {
                    setIsPlaying(true);
                    handleSeekTimeline(0);
                  }
                }}
                className="p-1.5 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 transition"
                title="Phát lại từ đầu"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>

              {!isSlotMode && enableVoice && voiceTrack && (
                <button
                  onClick={() => setMutedVoice((m) => !m)}
                  className="p-1.5 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 transition"
                  title="Bật/tắt tiếng voice mới"
                >
                  {mutedVoice ? (
                    <VolumeX className="w-3.5 h-3.5 text-rose-400" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                </button>
              )}
            </div>

            {/* Time Indicator */}
            {isSlotMode && isoSlot ? (
              <div className="text-[11px] font-mono text-amber-300 font-bold">
                {Math.max(
                  0,
                  (slotCurrentSec - isoSlot.videoBegin) / (isoSlot.speed || 1)
                ).toFixed(1)}
                s /{" "}
                {(
                  (isoSlot.videoEnd - isoSlot.videoBegin) /
                  (isoSlot.speed || 1)
                ).toFixed(1)}
                s
              </div>
            ) : (
              <div className="text-[11px] font-mono text-slate-300">
                {timelineSec.toFixed(1)}s / {totalDuration.toFixed(1)}s
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
