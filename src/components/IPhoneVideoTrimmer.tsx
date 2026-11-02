"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import { RotateCcw } from "lucide-react";

export interface IPhoneVideoTrimmerProps {
  videoBegin: number;
  videoEnd: number;
  maxDuration?: number;
  totalDuration?: number;
  rawBegin?: number;
  rawEnd?: number;
  contextPadding?: number;
  onChange: (begin: number, end: number) => void;
  onSeekPreview?: (targetSec: number) => void;
  onScrubStart?: () => void;
  onScrubMove?: (sourceSec: number) => void;
  onScrubEnd?: () => void;
  step?: number;
  minClipDuration?: number;
  className?: string;
}

export default function IPhoneVideoTrimmer({
  videoBegin,
  videoEnd,
  maxDuration,
  totalDuration,
  rawBegin,
  rawEnd,
  contextPadding = 6.0,
  onChange,
  onSeekPreview,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
  step = 0.1,
  minClipDuration = 0.2,
  className = "",
}: IPhoneVideoTrimmerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeDrag, setActiveDrag] = useState<"begin" | "end" | "middle" | null>(null);

  // Total limit of the video timeline
  const safeTotal = Math.max(0.5, totalDuration ?? maxDuration ?? 10);
  const safeBegin = Math.max(0, Math.min(safeTotal - minClipDuration, videoBegin || 0));
  const safeEnd = Math.max(safeBegin + minClipDuration, Math.min(safeTotal, videoEnd || safeTotal));

  // Phương án A: Context padding window xung quanh shot
  const hasRaw = rawBegin !== undefined && rawEnd !== undefined;
  const baseRawBegin = hasRaw ? rawBegin! : safeBegin;
  const baseRawEnd = hasRaw ? rawEnd! : safeEnd;

  // View window: mở rộng thêm vùng đệm ngữ cảnh trước & sau shot
  const windowStart = Math.max(0, Math.min(baseRawBegin, safeBegin) - contextPadding);
  const windowEnd = Math.min(safeTotal, Math.max(baseRawEnd, safeEnd) + contextPadding);
  const windowSpan = Math.max(0.2, windowEnd - windowStart);

  // Calculate percentage positions on the visible track
  const beginPercent = Math.max(0, Math.min(100, ((safeBegin - windowStart) / windowSpan) * 100));
  const endPercent = Math.max(0, Math.min(100, ((safeEnd - windowStart) / windowSpan) * 100));
  const widthPercent = Math.max(0, endPercent - beginPercent);

  // Ghost markers positions (mốc cảnh gốc AI phát hiện)
  const rawBeginPercent = hasRaw
    ? ((baseRawBegin - windowStart) / windowSpan) * 100
    : null;
  const rawEndPercent = hasRaw
    ? ((baseRawEnd - windowStart) / windowSpan) * 100
    : null;

  // Helper to round seconds to step precision (e.g. 0.1s)
  const roundSec = useCallback(
    (sec: number) => {
      const factor = 1 / step;
      return Math.round(sec * factor) / factor;
    },
    [step]
  );

  const dragStartRef = useRef<{
    startX: number;
    initialBegin: number;
    initialEnd: number;
    trackWidth: number;
    windowSpan: number;
    windowStart: number;
    windowEnd: number;
  }>({
    startX: 0,
    initialBegin: 0,
    initialEnd: 0,
    trackWidth: 1,
    windowSpan: 1,
    windowStart: 0,
    windowEnd: 1,
  });

  const handlePointerDown = (
    e: React.PointerEvent,
    type: "begin" | "end" | "middle"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!trackRef.current) return;

    const rect = trackRef.current.getBoundingClientRect();
    dragStartRef.current = {
      startX: e.clientX,
      initialBegin: safeBegin,
      initialEnd: safeEnd,
      trackWidth: Math.max(10, rect.width),
      windowSpan,
      windowStart,
      windowEnd,
    };
    setActiveDrag(type);

    onScrubStart?.();
    const targetSec = type === "end" ? safeEnd : safeBegin;
    if (onScrubMove) onScrubMove(targetSec);
    if (onSeekPreview) onSeekPreview(targetSec);
  };

  useEffect(() => {
    if (!activeDrag) return;

    const handlePointerMove = (e: PointerEvent) => {
      const {
        startX,
        initialBegin,
        initialEnd,
        trackWidth,
        windowSpan: dragSpan,
        windowStart: dragWinStart,
        windowEnd: dragWinEnd,
      } = dragStartRef.current;

      const deltaPx = e.clientX - startX;
      const deltaSec = (deltaPx / trackWidth) * dragSpan;

      if (activeDrag === "begin") {
        let newBegin = roundSec(initialBegin + deltaSec);
        newBegin = Math.max(dragWinStart, Math.min(safeEnd - minClipDuration, newBegin));
        onChange(newBegin, safeEnd);
        if (onScrubMove) onScrubMove(newBegin);
        if (onSeekPreview) onSeekPreview(newBegin);
      } else if (activeDrag === "end") {
        let newEnd = roundSec(initialEnd + deltaSec);
        newEnd = Math.max(safeBegin + minClipDuration, Math.min(dragWinEnd, newEnd));
        onChange(safeBegin, newEnd);
        if (onScrubMove) onScrubMove(newEnd);
        if (onSeekPreview) onSeekPreview(newEnd);
      } else if (activeDrag === "middle") {
        const span = initialEnd - initialBegin;
        let newBegin = roundSec(initialBegin + deltaSec);
        if (newBegin < dragWinStart) newBegin = dragWinStart;
        if (newBegin + span > dragWinEnd) newBegin = dragWinEnd - span;
        const newEnd = roundSec(newBegin + span);
        onChange(newBegin, newEnd);
        if (onScrubMove) onScrubMove(newBegin);
        if (onSeekPreview) onSeekPreview(newBegin);
      }
    };

    const handlePointerUp = () => {
      setActiveDrag(null);
      onScrubEnd?.();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    activeDrag,
    safeBegin,
    safeEnd,
    minClipDuration,
    onChange,
    onSeekPreview,
    onScrubMove,
    onScrubEnd,
    roundSec,
  ]);

  // Adjust begin / end via buttons
  const stepBegin = (amount: number) => {
    const next = roundSec(
      Math.max(0, Math.min(safeEnd - minClipDuration, safeBegin + amount))
    );
    onChange(next, safeEnd);
    if (onSeekPreview) onSeekPreview(next);
    onScrubEnd?.();
  };

  const stepEnd = (amount: number) => {
    const next = roundSec(
      Math.max(safeBegin + minClipDuration, Math.min(safeTotal, safeEnd + amount))
    );
    onChange(safeBegin, next);
    if (onSeekPreview) onSeekPreview(next);
    onScrubEnd?.();
  };

  // Nút về cảnh gốc
  const handleReset = () => {
    if (hasRaw && rawBegin !== undefined && rawEnd !== undefined) {
      onChange(rawBegin, rawEnd);
      if (onSeekPreview) onSeekPreview(rawBegin);
    } else {
      onChange(0, safeTotal);
      if (onSeekPreview) onSeekPreview(0);
    }
    onScrubEnd?.();
  };

  const isModifiedFromRaw =
    hasRaw &&
    rawBegin !== undefined &&
    rawEnd !== undefined &&
    (Math.abs(safeBegin - rawBegin) > 0.05 || Math.abs(safeEnd - rawEnd) > 0.05);

  return (
    <div
      className={`space-y-2 p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 ${className}`}
    >
      {/* Header bar of trimmer */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-slate-200 text-[11px]">
            Cắt bớt đầu / cuối (Kéo 2 đầu):
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
            {roundSec(safeEnd - safeBegin).toFixed(1)}s
          </span>
          {isModifiedFromRaw && rawBegin !== undefined && rawEnd !== undefined && (
            <span
              className="text-[10px] font-mono text-indigo-300/90 ml-1"
              title={`Cảnh gốc: ${rawBegin.toFixed(1)}s → ${rawEnd.toFixed(1)}s`}
            >
              (Gốc: {roundSec(rawEnd - rawBegin).toFixed(1)}s)
            </span>
          )}
        </div>

        {/* Nút về cảnh gốc */}
        <button
          type="button"
          onClick={handleReset}
          className="text-[10px] text-slate-400 hover:text-amber-300 inline-flex items-center gap-1 transition"
          title={
            hasRaw
              ? "Khôi phục lại mốc cảnh gốc ban đầu"
              : "Khôi phục toàn bộ cảnh"
          }
        >
          <RotateCcw className="w-3 h-3" />
          <span>{hasRaw ? "Về cảnh gốc" : "Trọn cảnh"}</span>
        </button>
      </div>

      {/* iOS-Style Dual Handle Trimmer Bar */}
      <div
        ref={trackRef}
        className="relative h-11 w-full bg-slate-900/90 rounded-lg select-none border border-slate-700/60 overflow-hidden cursor-default shadow-inner"
        style={{ touchAction: "none" }}
      >
        {/* Subtle background tick marks simulating a filmstrip */}
        <div className="absolute inset-0 opacity-15 pointer-events-none flex justify-between px-2 items-center">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="w-[1px] h-4 bg-slate-400" />
          ))}
        </div>

        {/* Dimmed Left Side (cut out) */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-slate-950/75 pointer-events-none transition-all duration-75"
          style={{ width: `${beginPercent}%` }}
        />

        {/* Dimmed Right Side (cut out) */}
        <div
          className="absolute top-0 bottom-0 right-0 bg-slate-950/75 pointer-events-none transition-all duration-75"
          style={{ left: `${endPercent}%` }}
        />

        {/* Ghost markers - Vạch dấu mờ mốc cảnh gốc AI phát hiện */}
        {hasRaw &&
          rawBeginPercent !== null &&
          rawBeginPercent >= 0 &&
          rawBeginPercent <= 100 && (
            <div
              className="absolute top-0 bottom-0 w-[2px] border-l-2 border-dashed border-indigo-400/50 pointer-events-none z-10"
              style={{ left: `${rawBeginPercent}%` }}
              title={`Mốc bắt đầu cảnh gốc: ${rawBegin?.toFixed(1)}s`}
            />
          )}

        {hasRaw &&
          rawEndPercent !== null &&
          rawEndPercent >= 0 &&
          rawEndPercent <= 100 && (
            <div
              className="absolute top-0 bottom-0 w-[2px] border-l-2 border-dashed border-indigo-400/50 pointer-events-none z-10"
              style={{ left: `${rawEndPercent}%` }}
              title={`Mốc kết thúc cảnh gốc: ${rawEnd?.toFixed(1)}s`}
            />
          )}

        {/* Selected Active Region (Amber Frame - iPhone Style) */}
        <div
          className="absolute top-0 bottom-0 border-y-2 border-amber-400 bg-amber-400/10 flex items-center justify-between"
          style={{
            left: `${beginPercent}%`,
            width: `${widthPercent}%`,
            cursor: activeDrag === "middle" ? "grabbing" : "grab",
          }}
          onPointerDown={(e) => handlePointerDown(e, "middle")}
          title="Kéo ở giữa để di chuyển cả đoạn cắt"
        >
          {/* Left Handle (Apple Photos style) */}
          <div
            onPointerDown={(e) => handlePointerDown(e, "begin")}
            className="absolute -left-[1px] top-0 bottom-0 w-4 bg-amber-400 hover:bg-amber-300 active:bg-amber-200 rounded-l-md flex items-center justify-center cursor-ew-resize select-none shadow-md transition-colors z-20"
            title={`Kéo mốc bắt đầu (${safeBegin.toFixed(1)}s)`}
          >
            <div className="flex flex-col gap-0.5 pointer-events-none">
              <span className="w-0.5 h-3 bg-slate-950 rounded-full" />
              <span className="w-0.5 h-3 bg-slate-950 rounded-full" />
            </div>
            {/* Live tooltip */}
            {activeDrag === "begin" && (
              <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-amber-400 text-slate-950 text-[10px] font-bold font-mono shadow whitespace-nowrap pointer-events-none z-30">
                {safeBegin.toFixed(1)}s
              </div>
            )}
          </div>

          {/* Center Info inside Frame */}
          <div className="w-full text-center text-[10px] font-mono font-bold text-amber-200 pointer-events-none truncate px-4">
            {safeBegin.toFixed(1)}s → {safeEnd.toFixed(1)}s
          </div>

          {/* Right Handle (Apple Photos style) */}
          <div
            onPointerDown={(e) => handlePointerDown(e, "end")}
            className="absolute -right-[1px] top-0 bottom-0 w-4 bg-amber-400 hover:bg-amber-300 active:bg-amber-200 rounded-r-md flex items-center justify-center cursor-ew-resize select-none shadow-md transition-colors z-20"
            title={`Kéo mốc kết thúc (${safeEnd.toFixed(1)}s)`}
          >
            <div className="flex flex-col gap-0.5 pointer-events-none">
              <span className="w-0.5 h-3 bg-slate-950 rounded-full" />
              <span className="w-0.5 h-3 bg-slate-950 rounded-full" />
            </div>
            {/* Live tooltip */}
            {activeDrag === "end" && (
              <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-amber-400 text-slate-950 text-[10px] font-bold font-mono shadow whitespace-nowrap pointer-events-none z-30">
                {safeEnd.toFixed(1)}s
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Fine-Tuning Controls Row */}
      <div className="grid grid-cols-2 gap-2 pt-0.5">
        {/* Start Point Controls */}
        <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-lg p-1 text-xs">
          <span className="text-[10px] text-slate-400 px-1 font-medium shrink-0">
            Đầu:
          </span>
          <button
            type="button"
            onClick={() => stepBegin(-0.1)}
            disabled={safeBegin <= 0}
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-mono text-[10px]"
            title="Lùi 0.1s"
          >
            -0.1s
          </button>
          <input
            type="number"
            step="0.1"
            min="0"
            max={Math.max(0, safeEnd - minClipDuration)}
            value={safeBegin}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) {
                const next = Math.max(
                  0,
                  Math.min(safeEnd - minClipDuration, roundSec(val))
                );
                onChange(next, safeEnd);
                if (onSeekPreview) onSeekPreview(next);
              }
            }}
            className="w-full text-center bg-slate-950 border border-slate-700/80 rounded px-1 py-0.5 text-[11px] font-mono text-amber-300 font-semibold focus:outline-none focus:border-amber-400"
          />
          <button
            type="button"
            onClick={() => stepBegin(0.1)}
            disabled={safeBegin >= safeEnd - minClipDuration}
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-mono text-[10px]"
            title="Tiến 0.1s"
          >
            +0.1s
          </button>
        </div>

        {/* End Point Controls */}
        <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-lg p-1 text-xs">
          <span className="text-[10px] text-slate-400 px-1 font-medium shrink-0">
            Cuối:
          </span>
          <button
            type="button"
            onClick={() => stepEnd(-0.1)}
            disabled={safeEnd <= safeBegin + minClipDuration}
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-mono text-[10px]"
            title="Lùi 0.1s"
          >
            -0.1s
          </button>
          <input
            type="number"
            step="0.1"
            min={safeBegin + minClipDuration}
            max={safeTotal}
            value={safeEnd}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) {
                const next = Math.max(
                  safeBegin + minClipDuration,
                  Math.min(safeTotal, roundSec(val))
                );
                onChange(safeBegin, next);
                if (onSeekPreview) onSeekPreview(next);
              }
            }}
            className="w-full text-center bg-slate-950 border border-slate-700/80 rounded px-1 py-0.5 text-[11px] font-mono text-amber-300 font-semibold focus:outline-none focus:border-amber-400"
          />
          <button
            type="button"
            onClick={() => stepEnd(0.1)}
            disabled={safeEnd >= safeTotal}
            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-mono text-[10px]"
            title="Tiến 0.1s"
          >
            +0.1s
          </button>
        </div>
      </div>
    </div>
  );
}
