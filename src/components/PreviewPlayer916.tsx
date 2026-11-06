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
  pauseTrigger?: number;
  onPlayingChange?: (playing: boolean) => void;
}

export default function PreviewPlayer916({
  composed,
  sourceVideo,
  voiceTrack,
  enableVoice = true,
  seekTimelineSec,
  previewMode = "full",
  isolatedSlotIndex,
  isScrubbing = false,
  scrubSourceSec,
  playTrigger,
  pauseTrigger,
  onPlayingChange,
}: PreviewPlayer916Props) {
  // Dual Video Buffering (Ping-Pong A & B)
  const videoRefA = useRef<HTMLVideoElement | null>(null);
  const videoRefB = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);

  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const preloadedSlotIndexRef = useRef<number | null>(null);

  const [isPlaying, setIsPlayingState] = useState(false);
  const [timelineSec, setTimelineSec] = useState(0);
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  const [slotCurrentSec, setSlotCurrentSec] = useState(0);
  const [mutedVoice, setMutedVoice] = useState(false);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [isDraggingBar, setIsDraggingBar] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  const timelineSecRef = useRef(0);
  const activeSlotIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  const isBufferingRef = useRef(false);
  const onPlayingChangeRef = useRef(onPlayingChange);

  const setBufferingSync = useCallback((nextBuffering: boolean) => {
    if (isBufferingRef.current !== nextBuffering) {
      isBufferingRef.current = nextBuffering;
      setIsBuffering(nextBuffering);
    }
  }, []);

  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const setPlayingSync = useCallback(
    (nextPlaying: boolean) => {
      isPlayingRef.current = nextPlaying;
      setIsPlayingState(nextPlaying);
      if (!nextPlaying) {
        setBufferingSync(false);
      }
      onPlayingChangeRef.current?.(nextPlaying);
    },
    [setBufferingSync]
  );

  const totalDuration = Math.max(0.5, composed.finalDuration || 20);
  const rawVoiceUrl = voiceTrack?.localUrl || "";
  const voiceDuration = voiceTrack?.duration || totalDuration;

  const isSlotMode =
    previewMode === "slot" &&
    typeof isolatedSlotIndex === "number" &&
    isolatedSlotIndex >= 0 &&
    isolatedSlotIndex < composed.slots.length;

  const isoSlot =
    isSlotMode && typeof isolatedSlotIndex === "number"
      ? composed.slots[isolatedSlotIndex]
      : null;

  const currentSlot =
    isSlotMode && isoSlot
      ? isoSlot
      : composed.slots[activeSlotIndex] || composed.slots[0];

  const catMeta = SHOT_CATEGORIES.find((c) => c.id === currentSlot?.category);

  // In full mode: even slots use Video A, odd slots use Video B.
  // In slot mode: always use Video A.
  const isVideoAActive = isSlotMode ? true : activeSlotIndex % 2 === 0;

  // Background pre-cache Drive video streams into browser RAM Blob URLs (prioritizing slot 0)
  useEffect(() => {
    let active = true;

    const cacheQueue = async () => {
      // 1. Fetch slot 0 first with highest network priority
      const slot0 = composed.slots[0];
      const url0 = slot0?.localUrl;
      if (
        url0 &&
        url0.startsWith("/api/drive-stream/") &&
        !driveBlobCache.has(url0)
      ) {
        try {
          const res = await fetch(url0);
          if (res.ok && active) {
            const blob = await res.blob();
            driveBlobCache.set(url0, URL.createObjectURL(blob));
          }
        } catch {
          // ignore
        }
      }

      // 2. Fetch remaining slots in sequence so initial bandwidth isn't choked
      for (let i = 1; i < composed.slots.length; i++) {
        if (!active) break;
        const slot = composed.slots[i];
        const url = slot?.localUrl;
        if (
          url &&
          url.startsWith("/api/drive-stream/") &&
          !driveBlobCache.has(url)
        ) {
          try {
            const res = await fetch(url);
            if (res.ok && active) {
              const blob = await res.blob();
              driveBlobCache.set(url, URL.createObjectURL(blob));
            }
          } catch {
            // ignore
          }
        }
      }
    };

    cacheQueue();

    return () => {
      active = false;
    };
  }, [composed]);

  // Keep <audio> element src synchronized with rawVoiceUrl without unmounting or resetting buffer
  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    if (!enableVoice || !rawVoiceUrl) {
      audioEl.pause();
      audioEl.removeAttribute("src");
      return;
    }
    const currentAttr = audioEl.getAttribute("data-voice-url") || "";
    if (currentAttr !== rawVoiceUrl) {
      audioEl.setAttribute("data-voice-url", rawVoiceUrl);
      audioEl.src = rawVoiceUrl;
      audioEl.currentTime = timelineSecRef.current;
    }
  }, [enableVoice, rawVoiceUrl]);

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
    [composed.slots, getSlotMediaUrl, isSlotMode]
  );

  // Jump to specific point in full mode
  const handleSeekTimeline = useCallback(
    (targetSec: number, forcePlay?: boolean) => {
      const shouldPlay = forcePlay !== undefined ? forcePlay : isPlayingRef.current;
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
      const idleVid = isA ? videoRefB.current : videoRefA.current;
      const mediaUrl = getSlotMediaUrl(slot);

      if (idleVid) {
        idleVid.pause();
      }

      if (targetVid && mediaUrl) {
        if (
          !targetVid.src ||
          (!targetVid.src.endsWith(mediaUrl) && targetVid.src !== mediaUrl)
        ) {
          targetVid.src = mediaUrl;
        }
        targetVid.currentTime = targetSourceTime;
        targetVid.playbackRate = Math.min(4, Math.max(0.25, slot.speed || 1));
      }

      const audioEl = audioRef.current;
      if (audioEl && enableVoice && rawVoiceUrl) {
        const currentAttr = audioEl.getAttribute("data-voice-url") || "";
        if (currentAttr !== rawVoiceUrl) {
          audioEl.setAttribute("data-voice-url", rawVoiceUrl);
          audioEl.src = rawVoiceUrl;
        }
        const audioDur = voiceDuration || audioEl.duration || totalDuration;
        if (clamped < audioDur) {
          audioEl.currentTime = clamped;
        } else {
          audioEl.pause();
        }
      }

      if (shouldPlay) {
        setBufferingSync(true);
      } else {
        targetVid?.pause();
        audioEl?.pause();
        setBufferingSync(false);
      }

      preloadedSlotIndexRef.current = null;
      preloadNextSlot(targetIndex);
    },
    [
      composed.slots,
      enableVoice,
      getSlotMediaUrl,
      preloadNextSlot,
      rawVoiceUrl,
      setBufferingSync,
      totalDuration,
      voiceDuration,
    ]
  );

  const handleSeekRef = useRef(handleSeekTimeline);
  useEffect(() => {
    handleSeekRef.current = handleSeekTimeline;
  }, [handleSeekTimeline]);

  // Reset when switching to a different composed video
  const prevComposedIdRef = useRef(composed.id);
  useEffect(() => {
    const isChanged = prevComposedIdRef.current !== composed.id;
    prevComposedIdRef.current = composed.id;

    preloadedSlotIndexRef.current = null;
    timelineSecRef.current = 0;
    activeSlotIndexRef.current = 0;

    if (isChanged) {
      const timer = setTimeout(() => {
        setPlayingSync(false);
        setTimelineSec(0);
        setActiveSlotIndex(0);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [composed.id, setPlayingSync]);

  // Initial media setup when composed or mode changes while paused
  useEffect(() => {
    if (isPlayingRef.current) return;

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
        vidA.pause();
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
      vidA.pause();
    }
    if (vidB && slot1 && url1) {
      if (!vidB.src || (!vidB.src.endsWith(url1) && vidB.src !== url1)) {
        vidB.src = url1;
      }
      vidB.currentTime = slot1.videoBegin;
      vidB.playbackRate = Math.min(4, Math.max(0.25, slot1.speed || 1));
      vidB.pause();
      preloadedSlotIndexRef.current = 1;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [composed, getSlotMediaUrl, isSlotMode, isoSlot]);

  // Handle external playTrigger (e.g., "Phát" button on card or "Xem đoạn này")
  const lastPlayTriggerRef = useRef<number>(0);
  useEffect(() => {
    if (
      playTrigger !== undefined &&
      playTrigger > 0 &&
      playTrigger !== lastPlayTriggerRef.current
    ) {
      lastPlayTriggerRef.current = playTrigger;
      const timer = setTimeout(() => {
        setPlayingSync(true);
        if (isSlotMode && isoSlot && videoRefA.current) {
          const url = getSlotMediaUrl(isoSlot);
          if (
            url &&
            (!videoRefA.current.src ||
              (!videoRefA.current.src.endsWith(url) &&
                videoRefA.current.src !== url))
          ) {
            videoRefA.current.src = url;
          }
          videoRefA.current.currentTime = isoSlot.videoBegin;
          videoRefA.current.playbackRate = Math.min(
            4,
            Math.max(0.25, isoSlot.speed || 1)
          );
          setBufferingSync(true);
          if (audioRef.current && enableVoice && rawVoiceUrl) {
            audioRef.current.currentTime = isoSlot.enterBegin;
          } else if (audioRef.current) {
            audioRef.current.pause();
          }
        } else {
          // Start from 0s or resume current position if mid-timeline
          const startPos =
            timelineSecRef.current >= totalDuration - 0.15
              ? 0
              : timelineSecRef.current;
          handleSeekRef.current(startPos, true);
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [
    playTrigger,
    isSlotMode,
    isoSlot,
    getSlotMediaUrl,
    setPlayingSync,
    setBufferingSync,
    totalDuration,
  ]);

  // Handle external pauseTrigger (e.g. clicking "Tạm dừng" on combination card)
  const lastPauseTriggerRef = useRef<number>(0);
  useEffect(() => {
    if (
      pauseTrigger !== undefined &&
      pauseTrigger > 0 &&
      pauseTrigger !== lastPauseTriggerRef.current
    ) {
      lastPauseTriggerRef.current = pauseTrigger;
      const timer = setTimeout(() => {
        setPlayingSync(false);
        videoRefA.current?.pause();
        videoRefB.current?.pause();
        audioRef.current?.pause();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [pauseTrigger, setPlayingSync]);

  // Scrubbing in slot mode: live seek video to scrubSourceSec
  useEffect(() => {
    if (
      isSlotMode &&
      isScrubbing &&
      typeof scrubSourceSec === "number" &&
      !isNaN(scrubSourceSec)
    ) {
      if (videoRefA.current) {
        videoRefA.current.pause();
        videoRefA.current.currentTime = scrubSourceSec;
      }
      if (audioRef.current && enableVoice && rawVoiceUrl && isoSlot) {
        audioRef.current.pause();
        const progress = Math.max(
          0,
          Math.min(
            1,
            (scrubSourceSec - isoSlot.videoBegin) /
              Math.max(0.001, isoSlot.videoEnd - isoSlot.videoBegin)
          )
        );
        audioRef.current.currentTime =
          isoSlot.enterBegin + progress * (isoSlot.exitEnd - isoSlot.enterBegin);
      }
      const timer = setTimeout(() => {
        setSlotCurrentSec(scrubSourceSec);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isSlotMode, isScrubbing, scrubSourceSec, enableVoice, rawVoiceUrl, isoSlot]);

  // External seekTimelineSec for full mode
  useEffect(() => {
    if (
      !isSlotMode &&
      typeof seekTimelineSec === "number" &&
      !isNaN(seekTimelineSec)
    ) {
      const timer = setTimeout(() => {
        handleSeekRef.current(seekTimelineSec);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [seekTimelineSec, isSlotMode]);

  // Main high-performance playback tick loop
  useEffect(() => {
    if (!isPlaying || (isSlotMode && isScrubbing) || isDraggingBar) {
      videoRefA.current?.pause();
      videoRefB.current?.pause();
      audioRef.current?.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = null;
      return;
    }

    // SLOT MODE: Loop isolated slot with voice track sync
    if (isSlotMode && isoSlot) {
      const vidA = videoRefA.current;
      const mediaUrl = getSlotMediaUrl(isoSlot);
      if (vidA && mediaUrl) {
        if (
          !vidA.src ||
          (!vidA.src.endsWith(mediaUrl) && vidA.src !== mediaUrl)
        ) {
          vidA.src = mediaUrl;
        }
        vidA.playbackRate = Math.min(4, Math.max(0.25, isoSlot.speed || 1));
        if (
          vidA.currentTime < isoSlot.videoBegin - 0.05 ||
          vidA.currentTime >= isoSlot.videoEnd - 0.05
        ) {
          vidA.currentTime = isoSlot.videoBegin;
        }
      }
      videoRefB.current?.pause();

      const audioEl = audioRef.current;
      if (audioEl && enableVoice && rawVoiceUrl) {
        const currentAttr = audioEl.getAttribute("data-voice-url") || "";
        if (currentAttr !== rawVoiceUrl) {
          audioEl.setAttribute("data-voice-url", rawVoiceUrl);
          audioEl.src = rawVoiceUrl;
        }
        const curTime = vidA ? vidA.currentTime : isoSlot.videoBegin;
        const progress = Math.max(
          0,
          Math.min(
            1,
            (curTime - isoSlot.videoBegin) /
              Math.max(0.001, isoSlot.videoEnd - isoSlot.videoBegin)
          )
        );
        audioEl.currentTime =
          isoSlot.enterBegin + progress * (isoSlot.exitEnd - isoSlot.enterBegin);
      } else if (audioEl) {
        audioEl.pause();
      }

      const tickSlot = () => {
        if (!isPlayingRef.current) return;
        if (vidA) {
          if (vidA.seeking || vidA.readyState < 2) {
            setBufferingSync(true);
            if (!vidA.paused) vidA.pause();
            if (audioEl && !audioEl.paused) audioEl.pause();
            rafRef.current = requestAnimationFrame(tickSlot);
            return;
          }

          setBufferingSync(false);
          if (vidA.paused) {
            vidA.play().catch(() => {});
          }

          const curTime = vidA.currentTime;
          setSlotCurrentSec(curTime);

          // Synchronize voice audio to current slot playback progress
          if (audioEl && enableVoice && rawVoiceUrl) {
            const progress = Math.max(
              0,
              Math.min(
                1,
                (curTime - isoSlot.videoBegin) /
                  Math.max(0.001, isoSlot.videoEnd - isoSlot.videoBegin)
              )
            );
            const targetAudio =
              isoSlot.enterBegin +
              progress * (isoSlot.exitEnd - isoSlot.enterBegin);
            if (audioEl.paused) {
              audioEl.play().catch(() => {});
            }
            if (Math.abs(audioEl.currentTime - targetAudio) > 0.25) {
              audioEl.currentTime = targetAudio;
            }
          }

          if (
            curTime >= isoSlot.videoEnd - 0.05 ||
            curTime < isoSlot.videoBegin - 0.05
          ) {
            vidA.currentTime = isoSlot.videoBegin;
            if (audioEl && enableVoice && rawVoiceUrl) {
              audioEl.currentTime = isoSlot.enterBegin;
            }
          }
        }
        rafRef.current = requestAnimationFrame(tickSlot);
      };

      rafRef.current = requestAnimationFrame(tickSlot);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }

    // FULL MODE: Ping-pong playback across all 5 slots + voice
    const currentSlotIdx = activeSlotIndexRef.current;
    const isA = currentSlotIdx % 2 === 0;
    const currentVid = isA ? videoRefA.current : videoRefB.current;
    const slot = composed.slots[currentSlotIdx];
    if (currentVid && slot) {
      const mediaUrl = getSlotMediaUrl(slot);
      if (
        mediaUrl &&
        (!currentVid.src ||
          (!currentVid.src.endsWith(mediaUrl) && currentVid.src !== mediaUrl))
      ) {
        currentVid.src = mediaUrl;
      }
      currentVid.playbackRate = Math.min(4, Math.max(0.25, slot.speed || 1));
    }

    const audioEl = audioRef.current;
    if (audioEl && enableVoice && rawVoiceUrl) {
      const currentAttr = audioEl.getAttribute("data-voice-url") || "";
      if (currentAttr !== rawVoiceUrl) {
        audioEl.setAttribute("data-voice-url", rawVoiceUrl);
        audioEl.src = rawVoiceUrl;
      }
      const audioDur = voiceDuration || audioEl.duration || totalDuration;
      if (timelineSecRef.current < audioDur) {
        if (Math.abs(audioEl.currentTime - timelineSecRef.current) > 0.25) {
          audioEl.currentTime = timelineSecRef.current;
        }
      } else {
        audioEl.pause();
      }
    }

    const tick = (now: number) => {
      if (!isPlayingRef.current) return;

      const activeIdx = activeSlotIndexRef.current;
      const activeVid =
        activeIdx % 2 === 0 ? videoRefA.current : videoRefB.current;
      const audioEl = audioRef.current;

      const isVoiceActive = enableVoice && Boolean(rawVoiceUrl) && !isSlotMode;
      const audioDur = isVoiceActive
        ? (voiceDuration || audioEl?.duration || totalDuration)
        : 0;
      const isVoiceNeededNow =
        isVoiceActive && timelineSecRef.current < audioDur;

      // Dual Sync Gate: Check BOTH active video and audio readiness
      const isVidBuffering = Boolean(
        activeVid && (activeVid.seeking || activeVid.readyState < 2)
      );
      const isAudioBuffering = Boolean(
        isVoiceNeededNow &&
        audioEl &&
        (audioEl.seeking || audioEl.readyState < 2)
      );

      if (isVidBuffering || isAudioBuffering) {
        setBufferingSync(true);
        if (activeVid && !activeVid.paused) {
          activeVid.pause();
        }
        if (audioEl && !audioEl.paused) {
          audioEl.pause();
        }
        lastTickRef.current = null;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Both Video and Audio are 100% ready! Clear buffering spinner
      setBufferingSync(false);

      if (activeVid && activeVid.paused) {
        activeVid.play().catch(() => {});
      }
      if (isVoiceNeededNow && audioEl && audioEl.paused) {
        audioEl.play().catch(() => {});
      }

      if (lastTickRef.current == null) {
        lastTickRef.current = now;
      }
      const delta = Math.min(0.1, (now - lastTickRef.current) / 1000);
      lastTickRef.current = now;

      let nextSec = timelineSecRef.current + delta;
      if (nextSec >= totalDuration) {
        nextSec = 0;
        timelineSecRef.current = 0;
        activeSlotIndexRef.current = 0;
        setTimelineSec(0);
        setActiveSlotIndex(0);

        const slot0 = composed.slots[0];
        if (videoRefA.current && slot0) {
          const url0 = getSlotMediaUrl(slot0);
          if (
            url0 &&
            (!videoRefA.current.src ||
              (!videoRefA.current.src.endsWith(url0) &&
                videoRefA.current.src !== url0))
          ) {
            videoRefA.current.src = url0;
          }
          videoRefA.current.currentTime = slot0.videoBegin;
          videoRefA.current.playbackRate = Math.min(
            4,
            Math.max(0.25, slot0.speed || 1)
          );
        }
        if (videoRefB.current) {
          videoRefB.current.pause();
          const slot1 = composed.slots[1];
          if (slot1) {
            const url1 = getSlotMediaUrl(slot1);
            if (
              url1 &&
              (!videoRefB.current.src ||
                (!videoRefB.current.src.endsWith(url1) &&
                  videoRefB.current.src !== url1))
            ) {
              videoRefB.current.src = url1;
            }
            videoRefB.current.currentTime = slot1.videoBegin;
            videoRefB.current.playbackRate = Math.min(
              4,
              Math.max(0.25, slot1.speed || 1)
            );
            preloadedSlotIndexRef.current = 1;
          }
        }
        if (audioRef.current && enableVoice && rawVoiceUrl) {
          audioRef.current.currentTime = 0;
        }
        setBufferingSync(true);
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
          const mediaUrl = getSlotMediaUrl(newSlot);
          if (
            mediaUrl &&
            (!nowActiveVid.src ||
              (!nowActiveVid.src.endsWith(mediaUrl) &&
                nowActiveVid.src !== mediaUrl))
          ) {
            nowActiveVid.src = mediaUrl;
          }
          nowActiveVid.playbackRate = Math.min(
            4,
            Math.max(0.25, newSlot.speed || 1)
          );
        }
        if (nowIdleVid) {
          nowIdleVid.pause();
        }

        preloadNextSlot(newSlotIdx);
      }

      // Keep audio drift in check gently
      if (isVoiceNeededNow && audioEl && !audioEl.paused) {
        if (Math.abs(audioEl.currentTime - nextSec) > 0.35) {
          audioEl.currentTime = nextSec;
        }
      } else if (audioEl && !isVoiceNeededNow && !audioEl.paused) {
        audioEl.pause();
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
    isDraggingBar,
    isoSlot,
    totalDuration,
    enableVoice,
    composed.slots,
    rawVoiceUrl,
    voiceDuration,
    preloadNextSlot,
    getSlotMediaUrl,
    setBufferingSync,
  ]);

  // Helper to convert pointer clientX on the YouTube progress bar into seconds
  const computeSecFromPointer = useCallback(
    (clientX: number) => {
      const bar = progressBarRef.current;
      if (!bar) return 0;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))
      );
      if (isSlotMode && isoSlot) {
        return (
          isoSlot.videoBegin +
          ratio * Math.max(0.1, isoSlot.videoEnd - isoSlot.videoBegin)
        );
      }
      return ratio * totalDuration;
    },
    [isSlotMode, isoSlot, totalDuration]
  );

  const applyBarSeek = useCallback(
    (clientX: number) => {
      const sec = computeSecFromPointer(clientX);
      if (isSlotMode && isoSlot) {
        setSlotCurrentSec(sec);
        if (videoRefA.current) {
          videoRefA.current.currentTime = sec;
        }
        if (audioRef.current && enableVoice && rawVoiceUrl) {
          const progress = Math.max(
            0,
            Math.min(
              1,
              (sec - isoSlot.videoBegin) /
                Math.max(0.001, isoSlot.videoEnd - isoSlot.videoBegin)
            )
          );
          audioRef.current.currentTime =
            isoSlot.enterBegin + progress * (isoSlot.exitEnd - isoSlot.enterBegin);
        }
      } else {
        handleSeekTimeline(sec);
      }
    },
    [computeSecFromPointer, enableVoice, handleSeekTimeline, isSlotMode, isoSlot, rawVoiceUrl]
  );

  // Compute live CSS transform & filter for the active or isolated slot
  const slotDuration =
    isSlotMode && isoSlot
      ? Math.max(
          0.2,
          (isoSlot.videoEnd - isoSlot.videoBegin) / (isoSlot.speed || 1)
        )
      : Math.max(
          0.2,
          (currentSlot?.exitEnd || 1) - (currentSlot?.enterBegin || 0)
        );

  const slotProgress =
    isSlotMode && isoSlot
      ? Math.min(
          1,
          Math.max(
            0,
            (slotCurrentSec - isoSlot.videoBegin) /
              Math.max(0.1, isoSlot.videoEnd - isoSlot.videoBegin)
          )
        )
      : Math.min(
          1,
          Math.max(
            0,
            (timelineSec - (currentSlot?.enterBegin || 0)) / slotDuration
          )
        );

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
  const cssFilter = `brightness(${brightness.toFixed(
    2
  )}) contrast(${contrast.toFixed(2)}) saturate(${saturate.toFixed(2)})`;

  // Progress percentage for YouTube-style bar
  const progressPct =
    isSlotMode && isoSlot
      ? Math.max(
          0,
          Math.min(
            100,
            ((slotCurrentSec - isoSlot.videoBegin) /
              Math.max(0.1, isoSlot.videoEnd - isoSlot.videoBegin)) *
              100
          )
        )
      : Math.max(0, Math.min(100, (timelineSec / totalDuration) * 100));

  // Hover chapter info on YouTube bar
  const hoverSlotLabel = (() => {
    if (hoverSec === null) return null;
    if (isSlotMode && isoSlot) {
      const rel = Math.max(
        0,
        (hoverSec - isoSlot.videoBegin) / (isoSlot.speed || 1)
      );
      return `${rel.toFixed(1)}s • ${isoSlot.category.toUpperCase()}`;
    }
    const found =
      composed.slots.find(
        (s) => hoverSec >= s.enterBegin && hoverSec <= s.exitEnd + 0.05
      ) || composed.slots[0];
    return `${hoverSec.toFixed(1)}s${
      found ? ` • ${found.category.toUpperCase()}` : ""
    }`;
  })();

  const hoverPct =
    hoverSec === null
      ? 0
      : isSlotMode && isoSlot
      ? Math.max(
          8,
          Math.min(
            92,
            ((hoverSec - isoSlot.videoBegin) /
              Math.max(0.1, isoSlot.videoEnd - isoSlot.videoBegin)) *
              100
          )
        )
      : Math.max(8, Math.min(92, (hoverSec / totalDuration) * 100));

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
                  catMeta?.badgeClass ||
                  "bg-rose-500/30 text-rose-200 border-rose-500/50"
                }`}
              >
                Cảnh {isoSlot.category.toUpperCase()} (Xem riêng)
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  isPlaying ? "bg-emerald-400 animate-pulse" : "bg-slate-400"
                }`}
              />
              <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                Cảnh {currentSlot?.category.toUpperCase()} (
                {activeSlotIndex + 1}/5)
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
        <div
          onClick={() => {
            if (isPlaying) {
              setPlayingSync(false);
            } else {
              setPlayingSync(true);
              if (isSlotMode && isoSlot) {
                setBufferingSync(true);
              } else {
                const startPos =
                  timelineSecRef.current >= totalDuration - 0.15
                    ? 0
                    : timelineSecRef.current;
                handleSeekTimeline(startPos, true);
              }
            }
          }}
          className="absolute inset-0 overflow-hidden flex items-center justify-center bg-black cursor-pointer"
        >
          {sourceVideo?.localUrl || composed.slots.some((s) => s.localUrl) ? (
            <>
              {/* Video Element A */}
              <video
                ref={videoRefA}
                muted
                playsInline
                preload="auto"
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-100 ${
                  isVideoAActive
                    ? "opacity-100 z-10"
                    : "opacity-0 z-0 pointer-events-none"
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
                  muted
                  playsInline
                  preload="auto"
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-100 ${
                    !isVideoAActive
                      ? "opacity-100 z-10"
                      : "opacity-0 z-0 pointer-events-none"
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

          {/* YouTube-Style Buffering Spinner Overlay */}
          {isBuffering && isPlaying && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/55 backdrop-blur-[2px] transition-opacity pointer-events-none animate-in fade-in duration-150">
              <div className="relative flex items-center justify-center">
                <div className="w-11 h-11 rounded-full border-[3px] border-white/20 border-t-red-500 animate-spin shadow-lg" />
              </div>
              <span className="text-[11px] font-medium text-white/90 mt-2.5 drop-shadow tracking-wide">
                Đang tải video...
              </span>
            </div>
          )}
        </div>

        {/* Always-mounted Audio Element for Voice Preview so it never loses buffer */}
        <audio
          ref={audioRef}
          preload="auto"
          muted={mutedVoice || !enableVoice}
        />

        {/* Bottom Overlay with YouTube-style Scrubber Bar */}
        <div className="relative z-20 p-3 bg-gradient-to-t from-black/95 via-black/70 to-transparent space-y-1.5">
          {/* Active Clip Title & Range */}
          {isSlotMode && isoSlot ? (
            <div className="flex items-center justify-between text-[11px] text-slate-200">
              <span className="font-medium truncate max-w-[160px] text-rose-300">
                {isoSlot.shotLabel}
              </span>
              <span className="font-mono text-[10px] text-amber-300 font-bold">
                Cắt: {isoSlot.videoBegin.toFixed(1)}s–
                {isoSlot.videoEnd.toFixed(1)}s
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px] text-slate-200">
              <span className="font-medium truncate max-w-[170px]">
                {currentSlot?.shotLabel}
              </span>
              <span className="font-mono text-[10px] text-slate-400">
                {currentSlot?.videoBegin.toFixed(1)}s–
                {currentSlot?.videoEnd.toFixed(1)}s
              </span>
            </div>
          )}

          {/* YouTube-Style Interactive Progress Bar with Chapter Markers */}
          <div
            ref={progressBarRef}
            onPointerMove={(e) => {
              setHoverSec(computeSecFromPointer(e.clientX));
              if (isDraggingBar) {
                applyBarSeek(e.clientX);
              }
            }}
            onPointerLeave={() => {
              if (!isDraggingBar) setHoverSec(null);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              setIsDraggingBar(true);
              applyBarSeek(e.clientX);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
              setIsDraggingBar(false);
              setHoverSec(null);
            }}
            className="relative w-full py-2 cursor-pointer group/bar select-none touch-none"
          >
            {/* Floating Hover Time + Chapter Tooltip */}
            {hoverSlotLabel && (
              <div
                style={{ left: `${hoverPct}%` }}
                className="
                  absolute -top-6 -translate-x-1/2 pointer-events-none
                  px-1.5 py-0.5 rounded bg-slate-900/95 border border-slate-700
                  text-[9px] font-mono font-bold text-white whitespace-nowrap shadow-lg
                "
              >
                {hoverSlotLabel}
              </div>
            )}

            {/* Track Background */}
            <div className="relative w-full h-1.5 group-hover/bar:h-2.5 bg-white/25 rounded-full transition-all duration-150 overflow-visible">
              {/* Hover Preview Ghost Fill */}
              {hoverSec !== null && (
                <div
                  className="absolute inset-y-0 left-0 bg-white/30 rounded-full pointer-events-none"
                  style={{ width: `${hoverPct}%` }}
                />
              )}

              {/* Active Red YouTube Progress Fill */}
              <div
                className={`absolute inset-y-0 left-0 rounded-full pointer-events-none ${
                  isSlotMode
                    ? "bg-amber-400"
                    : "bg-gradient-to-r from-rose-500 to-red-500"
                }`}
                style={{ width: `${progressPct}%` }}
              />

              {/* Chapter Boundary Ticks (Full Mode 5 Scenes) */}
              {!isSlotMode &&
                composed.slots.slice(1).map((slot, idx) => {
                  const tickPct = Math.max(
                    0,
                    Math.min(100, (slot.enterBegin / totalDuration) * 100)
                  );
                  return (
                    <div
                      key={`tick_${slot.category}_${idx}`}
                      style={{ left: `${tickPct}%` }}
                      className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-slate-950/90 z-10 pointer-events-none"
                    />
                  );
                })}

              {/* YouTube Scrubber Thumb Dot */}
              <div
                style={{ left: `${progressPct}%` }}
                className={`
                  absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-20
                  w-3.5 h-3.5 rounded-full ring-2 ring-white shadow-md
                  transition-transform duration-100 pointer-events-none
                  ${isSlotMode ? "bg-amber-400" : "bg-red-500"}
                  ${
                    isDraggingBar
                      ? "scale-125"
                      : "scale-90 group-hover/bar:scale-110"
                  }
                `}
              />
            </div>
          </div>

          {/* Controls Bar */}
          <div className="flex items-center justify-between pt-0.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (isPlaying) {
                    setPlayingSync(false);
                  } else {
                    setPlayingSync(true);
                    if (isSlotMode && isoSlot) {
                      setBufferingSync(true);
                    } else {
                      const startPos =
                        timelineSecRef.current >= totalDuration - 0.15
                          ? 0
                          : timelineSecRef.current;
                      handleSeekTimeline(startPos, true);
                    }
                  }
                }}
                className="p-1.5 rounded-lg bg-white text-slate-950 hover:bg-rose-100 transition shadow"
                title={isPlaying ? "Tạm dừng" : "Phát"}
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  if (isSlotMode && isoSlot && videoRefA.current) {
                    videoRefA.current.currentTime = isoSlot.videoBegin;
                    setSlotCurrentSec(isoSlot.videoBegin);
                    setPlayingSync(true);
                    setBufferingSync(true);
                  } else {
                    setPlayingSync(true);
                    handleSeekTimeline(0, true);
                  }
                }}
                className="p-1.5 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 transition"
                title="Phát lại từ đầu"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>

              {!isSlotMode && enableVoice && voiceTrack && (
                <button
                  type="button"
                  onClick={() => setMutedVoice((m) => !m)}
                  className="p-1.5 rounded-lg bg-slate-800/80 text-slate-200 hover:bg-slate-700 transition"
                  title="Bật/tắt tiếng voice"
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
