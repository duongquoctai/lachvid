import {
  AudioVideoSyncMode,
  CategoryMinDurations,
  ComposedVideo,
   computeShotSpeedForMinDuration,
  DEFAULT_CATEGORY_MIN_DURATIONS,
  DiversityConfig,
  ResolvedShotSlot,
  Shot,
  ShotCategory,
  SourceVideo,
  VoiceTrack,
  ZvidAudioElement,
  ZvidRenderPayload,
  ZvidVideoElement,
  ZvidXFadeEffect,
} from "@/types/lachvid";

export const CATEGORY_ORDER: ShotCategory[] = [
  "open",
  "product",
  "texture",
  "apply",
  "end",
];

const VARIANT_TRANSITIONS: ZvidXFadeEffect[] = [
  "fade",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "smoothleft",
  "dissolve",
];

/**
 * Simple deterministic PRNG (Mulberry32) so users can reproduce or reshuffle batches cleanly.
 */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Computes the Hamming distance between two 5-shot tuples (0 to 5).
 */
export function computeHammingDistance(
  tupleA: [string, string, string, string, string],
  tupleB: [string, string, string, string, string]
): number {
  let diff = 0;
  for (let i = 0; i < 5; i++) {
    if (tupleA[i] !== tupleB[i]) {
      diff++;
    }
  }
  return diff;
}

export interface PlannerResult {
  tuples: [Shot, Shot, Shot, Shot, Shot][];
  maxPossibleCombinations: number;
  categoryCounts: Record<ShotCategory, number>;
  shotUsageCounts: Record<string, number>;
  minPairwiseHamming: number;
  warnings: string[];
}

/**
 * Generates up to N distinct 5-shot tuples (one per category in order: open -> product -> texture -> apply -> end)
 * obeying:
 * 1. Mandatory >= 1 shot per category
 * 2. Strict tuple uniqueness
 * 3. Configurable minimum Hamming distance d_min between any pair of selected videos
 * 4. Configurable maximum shot frequency cap F_max across the batch
 * 5. Balanced usage scoring (prefers least-used shots first)
 */
export function planDiverseCombinations(
  shots: Shot[],
  config: DiversityConfig
): PlannerResult {
  const byCat: Record<ShotCategory, Shot[]> = {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  };

  for (const s of shots) {
    if (s.category && s.end > s.begin) {
      byCat[s.category].push(s);
    }
  }

  const categoryCounts: Record<ShotCategory, number> = {
    open: byCat.open.length,
    product: byCat.product.length,
    texture: byCat.texture.length,
    apply: byCat.apply.length,
    end: byCat.end.length,
  };

  const warnings: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    if (byCat[cat].length === 0) {
      warnings.push(`Category "${cat.toUpperCase()}" chưa có shot nào.`);
    }
  }

  if (warnings.length > 0) {
    return {
      tuples: [],
      maxPossibleCombinations: 0,
      categoryCounts,
      shotUsageCounts: {},
      minPairwiseHamming: 0,
      warnings,
    };
  }

  const maxPossibleCombinations =
    byCat.open.length *
    byCat.product.length *
    byCat.texture.length *
    byCat.apply.length *
    byCat.end.length;

  const rand = createSeededRandom(config.seed || Date.now());

  // Shuffle each category pool first so order is never biased by import sequence
  for (const cat of CATEGORY_ORDER) {
    const arr = byCat[cat];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  // Generate candidate pool:
  // - If total space <= 5,000, enumerate all combinations exactly.
  // - If total space > 5,000 (e.g. 10^5 = 100,000), use stratified Latin-square + random sampling
  //   so every clip in every category (especially OPEN) is uniformly represented.
  const allCandidates: [Shot, Shot, Shot, Shot, Shot][] = [];
  const limitEnumeration = 8000;

  if (maxPossibleCombinations <= 5000) {
    for (const sOpen of byCat.open) {
      for (const sProd of byCat.product) {
        for (const sTex of byCat.texture) {
          for (const sApp of byCat.apply) {
            for (const sEnd of byCat.end) {
              allCandidates.push([sOpen, sProd, sTex, sApp, sEnd]);
            }
          }
        }
      }
    }
    for (let i = allCandidates.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = allCandidates[i];
      allCandidates[i] = allCandidates[j];
      allCandidates[j] = tmp;
    }
  } else {
    const seenKeys = new Set<string>();
    const nOpen = byCat.open.length;
    const nProd = byCat.product.length;
    const nTex = byCat.texture.length;
    const nApp = byCat.apply.length;
    const nEnd = byCat.end.length;

    // Phase 1: Stratified Latin-hypercube sweeps so every open/product/texture/apply/end clip appears evenly
    const sweeps = Math.min(limitEnumeration, Math.max((config.targetCount || 20) * 40, 3000));
    for (let idx = 0; idx < sweeps * 2 && allCandidates.length < limitEnumeration; idx++) {
      const oIdx = idx % nOpen;
      const cycle = Math.floor(idx / nOpen);
      const pIdx = (oIdx + cycle * 3 + Math.floor(rand() * nProd)) % nProd;
      const tIdx = (oIdx * 2 + cycle * 5 + Math.floor(rand() * nTex)) % nTex;
      const aIdx = (oIdx * 3 + cycle * 7 + Math.floor(rand() * nApp)) % nApp;
      const eIdx = (oIdx * 5 + cycle * 11 + Math.floor(rand() * nEnd)) % nEnd;

      const sOpen = byCat.open[oIdx];
      const sProd = byCat.product[pIdx];
      const sTex = byCat.texture[tIdx];
      const sApp = byCat.apply[aIdx];
      const sEnd = byCat.end[eIdx];
      const key = `${sOpen.id}|${sProd.id}|${sTex.id}|${sApp.id}|${sEnd.id}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allCandidates.push([sOpen, sProd, sTex, sApp, sEnd]);
      }
    }
  }

  const selected: [Shot, Shot, Shot, Shot, Shot][] = [];
  const selectedIds: [string, string, string, string, string][] = [];
  const shotUsageCounts: Record<string, number> = {};
  for (const s of shots) {
    shotUsageCounts[s.id] = 0;
  }

  const targetN = Math.min(config.targetCount, maxPossibleCombinations);
  const minHamming = Math.max(1, Math.min(5, config.minHammingDistance));

  const usedCandidateIndices = new Set<number>();

  while (selected.length < targetN) {
    let bestIdx = -1;
    let bestScore = Infinity;

    const nextOrdinal = selected.length + 1;
    // Ideal round-robin cap per category at this point in the sequence
    const idealCapByCat = CATEGORY_ORDER.map((cat) =>
      Math.ceil(nextOrdinal / Math.max(1, byCat[cat].length))
    );

    const prevTupleIds = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    let currentMinHamming = minHamming;
    let allowOverIdealCap = 0;

    while (bestIdx === -1 && currentMinHamming >= 1) {
      for (let i = 0; i < allCandidates.length; i++) {
        if (usedCandidateIndices.has(i)) continue;
        const cand = allCandidates[i];
        const candIds: [string, string, string, string, string] = [
          cand[0].id,
          cand[1].id,
          cand[2].id,
          cand[3].id,
          cand[4].id,
        ];

        // 1. Check strict uniqueness and pairwise Hamming distance
        let isDuplicate = false;
        let minDistanceToPrev = 5;
        let totalDistanceSum = 0;
        for (const prevIds of selectedIds) {
          const dist = computeHammingDistance(candIds, prevIds);
          totalDistanceSum += dist;
          if (dist < minDistanceToPrev) minDistanceToPrev = dist;
          if (dist === 0) {
            isDuplicate = true;
            break;
          }
        }
        if (isDuplicate) continue;
        if (minDistanceToPrev < currentMinHamming) continue;

        // 2. Check per-category round-robin balance
        let overCapCount = 0;
        let usageScore = 0;
        for (let k = 0; k < 5; k++) {
          const u = shotUsageCounts[candIds[k]] || 0;
          if (u + 1 > idealCapByCat[k] + allowOverIdealCap) {
            overCapCount++;
          }
          // Weight slot 0 (OPEN hook) higher so opening clips rotate strictly
          const slotWeight = k === 0 ? 35 : 15;
          usageScore += u * slotWeight;
        }
        if (overCapCount > 0) continue;

        // 3. Penalize repeating the same clip as the immediately preceding video
        let consecutiveRepeatPenalty = 0;
        if (prevTupleIds) {
          if (candIds[0] === prevTupleIds[0] && byCat.open.length > 1) {
            consecutiveRepeatPenalty += 500;
          }
          for (let k = 1; k < 5; k++) {
            if (candIds[k] === prevTupleIds[k] && byCat[CATEGORY_ORDER[k]].length > 1) {
              consecutiveRepeatPenalty += 80;
            }
          }
        }

        const avgDistance = selectedIds.length > 0 ? totalDistanceSum / selectedIds.length : 5;
        const score =
          usageScore +
          consecutiveRepeatPenalty -
          minDistanceToPrev * 12 -
          avgDistance * 4;

        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) {
        if (allowOverIdealCap < 2) {
          allowOverIdealCap++;
        } else {
          allowOverIdealCap = 0;
          currentMinHamming--;
        }
      }
    }

    if (bestIdx === -1) {
      warnings.push(
        `Đã tạo tối đa ${selected.length}/${targetN} video (đã dùng hết các tổ hợp độc nhất có thể).`
      );
      break;
    }

    usedCandidateIndices.add(bestIdx);
    const chosen = allCandidates[bestIdx];
    selected.push(chosen);
    const chosenIds: [string, string, string, string, string] = [
      chosen[0].id,
      chosen[1].id,
      chosen[2].id,
      chosen[3].id,
      chosen[4].id,
    ];
    selectedIds.push(chosenIds);
    for (const id of chosenIds) {
      shotUsageCounts[id] = (shotUsageCounts[id] || 0) + 1;
    }
  }

  let minPairwiseHamming = 5;
  if (selectedIds.length <= 1) {
    minPairwiseHamming = 5;
  } else {
    for (let i = 0; i < selectedIds.length; i++) {
      for (let j = i + 1; j < selectedIds.length; j++) {
        const d = computeHammingDistance(selectedIds[i], selectedIds[j]);
        if (d < minPairwiseHamming) minPairwiseHamming = d;
      }
    }
  }

  return {
    tuples: selected,
    maxPossibleCombinations,
    categoryCounts,
    shotUsageCounts,
    minPairwiseHamming,
    warnings,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Builds a complete ComposedVideo & ZvidRenderPayload from a 5-shot tuple.
 * When preserveOriginalClips is true, keeps 100% of the clips' original speed (1.0),
 * full duration (no cut/slow-motion), and no random variant edits.
 */
export function buildComposedVideo(params: {
  index: number;
  tuple: [Shot, Shot, Shot, Shot, Shot];
  sourceVideo: SourceVideo;
  voiceTrack: VoiceTrack | null;
  syncMode: AudioVideoSyncMode;
  diversityConfig: DiversityConfig;
  categoryMinDurations?: CategoryMinDurations;
  existingJobId?: string;
  existingId?: string;
  preserveOriginalClips?: boolean;
}): ComposedVideo {
  const {
    index,
    tuple,
    sourceVideo,
    voiceTrack,
    syncMode,
    diversityConfig,
    categoryMinDurations,
    existingJobId,
    existingId,
    preserveOriginalClips = false,
  } = params;

  const minDurs: CategoryMinDurations = {
    ...DEFAULT_CATEGORY_MIN_DURATIONS,
    ...(categoryMinDurations || {}),
  };

  const rand = createSeededRandom((diversityConfig.seed || 42) + index * 97);

  // Step 1: Resolve Layer 1 + Layer 2 edits & base durations per slot
  const rawSlots = tuple.map((shot, idx) => {
    const isLast = idx === 4;
    const category = CATEGORY_ORDER[idx];
    const minCatDur = minDurs[category] ?? DEFAULT_CATEGORY_MIN_DURATIONS[category];
    const originalClipLen = Math.max(0.1, shot.end - shot.begin);

    // If preserveOriginalClips is true (Khâu 2): keep 100% original clip speed, bounds and no auto edits
    if (preserveOriginalClips) {
      return {
        shot,
        category,
        minCatDur,
        originalClipLen,
        baseClipLen: originalClipLen,
        videoEnd: shot.end,
        speed: shot.edits.speed && shot.edits.speed > 0 ? round3(shot.edits.speed) : 1.0,
        flipH: Boolean(shot.edits.flipH),
        zoom: shot.edits.zoom || false,
        cropParams: shot.edits.cropParams,
        filter: shot.edits.filter,
        transition: null,
        transitionDuration: 0,
      };
    }

    // Default behavior for Khâu 1 / auto-slow-motion
    const autoSlowSpeed = computeShotSpeedForMinDuration(originalClipLen, minCatDur);
    let speed =
      shot.edits.speed && shot.edits.speed !== 1
        ? shot.edits.speed
        : autoSlowSpeed;

    let flipH = shot.edits.flipH;
    let zoom: boolean | { depth: number } = shot.edits.zoom;
    const filter = shot.edits.filter ? { ...shot.edits.filter } : undefined;
    let transition: ZvidXFadeEffect | null = isLast
      ? null
      : shot.edits.transition || null;
    let transitionDuration = isLast
      ? 0
      : shot.edits.transitionDuration || diversityConfig.randomTransitionDuration || 0;

    if (diversityConfig.enableAutoVariantEdits) {
      // Randomize flipH only if not locked
      if (!shot.edits.lockFlipH && rand() > 0.5) {
        flipH = !flipH;
      }

      // Ken Burns zoom depth variation (1.08 to 1.24)
      if (!zoom) {
        if (rand() > 0.35) {
          zoom = { depth: round3(1.08 + rand() * 0.16) };
        }
      } else if (typeof zoom === "object" && zoom.depth) {
        zoom = {
          depth: round3(
            Math.min(10, Math.max(1.02, zoom.depth + (rand() - 0.5) * 0.1))
          ),
        };
      }

      const bShift = Math.round((rand() - 0.5) * 8);
      const cShift = Math.round((rand() - 0.5) * 10);
      const sShift = Math.round((rand() - 0.5) * 12);
      const mergedFilter = {
        ...(filter || {}),
        brightness: Math.max(-100, Math.min(100, (filter?.brightness || 0) + bShift)),
        contrast: Math.max(-100, Math.min(100, (filter?.contrast || 0) + cShift)),
        saturate: Math.max(-100, Math.min(100, (filter?.saturate || 0) + sShift)),
      };
      if (!isLast && !transition && diversityConfig.randomTransitionDuration > 0) {
        transition =
          VARIANT_TRANSITIONS[Math.floor(rand() * VARIANT_TRANSITIONS.length)];
        transitionDuration = diversityConfig.randomTransitionDuration;
      }

      return {
        shot,
        category,
        minCatDur,
        originalClipLen,
        baseClipLen: originalClipLen,
        videoEnd: shot.end,
        speed,
        flipH,
        zoom,
        cropParams: shot.edits.cropParams,
        filter: mergedFilter,
        transition,
        transitionDuration: transition ? transitionDuration : 0,
      };
    }

    return {
      shot,
      category,
      minCatDur,
      originalClipLen,
      baseClipLen: originalClipLen,
      videoEnd: shot.end,
      speed,
      flipH,
      zoom,
      cropParams: shot.edits.cropParams,
      filter,
      transition,
      transitionDuration: transition ? transitionDuration : 0,
    };
  });

  // Ensure transitionDuration never exceeds 35% of either adjacent clip's display duration
  for (let i = 0; i < 4; i++) {
    if (rawSlots[i].transition && rawSlots[i].transitionDuration > 0) {
      const dCurr = rawSlots[i].baseClipLen / rawSlots[i].speed;
      const dNext = rawSlots[i + 1].baseClipLen / rawSlots[i + 1].speed;
      const safeMaxOverlap = Math.min(dCurr, dNext) * 0.35;
      rawSlots[i].transitionDuration = round3(
        Math.min(rawSlots[i].transitionDuration, Math.max(0, safeMaxOverlap))
      );
      if (rawSlots[i].transitionDuration < 0.15) {
        rawSlots[i].transition = null;
        rawSlots[i].transitionDuration = 0;
      }
    }
  }

  // Step 2 & 3: Build timeline placements (enterBegin / exitEnd) preserving natural clip speed
  const resolvedSlots: ResolvedShotSlot[] = [];
  let cursor = 0;

  for (let i = 0; i < 5; i++) {
    const item = rawSlots[i];
    const isLast = i === 4;
    const adjustedSpeed = round3(item.speed || 1);
    const slotDuration = round3(item.baseClipLen / adjustedSpeed);
    const enterBegin = round3(cursor);
    const exitEnd = round3(enterBegin + slotDuration);

    const nextId = i < 4 ? `shot_${i + 2}_${rawSlots[i + 1].category}` : undefined;

    const actualOverlap =
      i < 4 && item.transition && item.transitionDuration > 0
        ? round3(Math.min(item.transitionDuration, slotDuration * 0.4))
        : 0;

    const slotCustomSrc = item.shot.edits?.customSrc;
    const slotCustomLocalUrl = item.shot.edits?.customLocalUrl;
    const slotCustomLocalPath = item.shot.edits?.customLocalPath;

    resolvedSlots.push({
      category: item.category,
      shotId: item.shot.id,
      shotLabel: item.shot.label,
      sourceVideoId: item.shot.sourceVideoId,
      videoBegin: round3(item.shot.begin),
      videoEnd: round3(item.videoEnd),
      originalVideoEnd: round3(item.shot.end),
      src: slotCustomSrc,
      localUrl: slotCustomLocalUrl,
      localPath: slotCustomLocalPath,
      enterBegin,
      exitEnd,
      speed: adjustedSpeed,
      flipH: item.flipH,
      zoom: item.zoom,
      cropParams: item.cropParams,
      filter: item.filter,
      transition: actualOverlap > 0 ? item.transition : null,
      transitionDuration: actualOverlap > 0 ? actualOverlap : undefined,
      transitionId: actualOverlap > 0 ? nextId : undefined,
    });

    cursor = exitEnd - actualOverlap;
  }

  const totalVisualDuration = round3(resolvedSlots[4].exitEnd);
  const finalDuration = totalVisualDuration;

  // Media URL used in Zvid payload (remote URL if uploaded, placeholder/local until lazy upload runs)
  const defaultVideoSrc =
    sourceVideo?.zvidRemoteUrl ||
    (sourceVideo?.fileName
      ? `https://cdn.zvid.io/pending-upload/${encodeURIComponent(sourceVideo.fileName)}`
      : "");

  const zvidVisuals: ZvidVideoElement[] = resolvedSlots.map((slot, idx) => {
    const el: ZvidVideoElement = {
      type: "VIDEO",
      id: `shot_${idx + 1}_${slot.category}`,
      src: slot.src || defaultVideoSrc,
      width: 1080,
      height: 1920,
      resize: "cover",
      position: "center-center",
      videoBegin: slot.videoBegin,
      videoEnd: slot.videoEnd,
      enterBegin: slot.enterBegin,
      exitEnd: slot.exitEnd,
      volume: 0, // Always mute original cosmetics review audio so new Voice takes over cleanly
      speed: slot.speed,
    };

    if (slot.flipH) el.flipH = true;
    if (slot.zoom) el.zoom = slot.zoom;
    if (slot.cropParams) el.cropParams = slot.cropParams;
    if (slot.filter) el.filter = slot.filter;
    if (slot.transition && slot.transitionDuration && slot.transitionId) {
      el.transition = slot.transition;
      el.transitionDuration = slot.transitionDuration;
      el.transitionId = slot.transitionId;
    }

    return el;
  });

  // Voice handling: Video duration (e.g. 20s) is always master.
  // - If Voice is shorter than finalDuration: play full voice from 0 to voiceTrack.duration.
  // - If Voice is longer than finalDuration:
  //   - "video_master" (default): trim voice at finalDuration
  //   - "voice_master": speed up voice slightly so full voice fits into finalDuration
  const zvidAudios: ZvidAudioElement[] = [];
  if (voiceTrack) {
    const audioSrc =
      voiceTrack.zvidRemoteUrl ||
      `https://cdn.zvid.io/pending-upload/${encodeURIComponent(voiceTrack.fileName)}`;

    if (voiceTrack.duration > finalDuration && syncMode === "voice_master") {
      const voiceSpeed = round3(
        Math.min(4, Math.max(0.5, voiceTrack.duration / finalDuration))
      );
      zvidAudios.push({
        src: audioSrc,
        enter: 0,
        exit: finalDuration,
        audioBegin: 0,
        audioEnd: round3(voiceTrack.duration),
        volume: 1,
        speed: voiceSpeed,
        matchDuration: true,
      });
    } else {
      const audioEndBound = round3(Math.min(voiceTrack.duration, finalDuration));
      zvidAudios.push({
        src: audioSrc,
        enter: 0,
        exit: audioEndBound,
        audioBegin: 0,
        audioEnd: audioEndBound,
        volume: 1,
      });
    }
  }

  const safeName = `lachvid_cosmetics_v${index + 1}`;
  const zvidPayload: ZvidRenderPayload = {
    type: "video",
    name: safeName,
    resolution: "custom",
    width: 1080,
    height: 1920,
    duration: round3(Math.max(0.5, finalDuration)),
    durationMode: "fixed",
    frameRate: 30,
    outputFormat: "mp4",
    backgroundColor: "#0b0d12",
    visuals: zvidVisuals,
    ...(zvidAudios.length > 0 ? { audios: zvidAudios } : {}),
  };

  const shotIds: [string, string, string, string, string] = [
    tuple[0].id,
    tuple[1].id,
    tuple[2].id,
    tuple[3].id,
    tuple[4].id,
  ];

  const now = new Date().toISOString();

  return {
    id: existingId || `comp_${index + 1}_${Date.now()}`,
    jobId: existingJobId || crypto.randomUUID(),
    name: `Video Remix #${index + 1}`,
    tupleKey: shotIds.join("|"),
    shotIds,
    slots: resolvedSlots,
    totalVisualDuration,
    finalDuration: zvidPayload.duration,
    voiceTrackId: voiceTrack?.id || null,
    syncMode,
    zvidPayload,
    validation: null,
    renderState: "draft",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Recalculates timeline placements (enterBegin/exitEnd), total duration, and zvidPayload
 * when user edits a single slot (speed, begin, end, flipH) in a composed video.
 */
export function recalculateComposedVideo(
  composed: ComposedVideo,
  slotIndex: number,
  slotEdits: Partial<ResolvedShotSlot>,
  voiceTrack?: VoiceTrack | null,
  syncMode: AudioVideoSyncMode = "video_master"
): ComposedVideo {
  const newSlots = composed.slots.map((s, idx) => {
    if (idx !== slotIndex) return { ...s };
    const updated = { ...s, ...slotEdits };
    if (updated.videoBegin < 0) updated.videoBegin = 0;
    if (updated.originalVideoEnd && updated.videoEnd > updated.originalVideoEnd) {
      updated.videoEnd = updated.originalVideoEnd;
    }
    if (updated.videoEnd <= updated.videoBegin + 0.2) {
      updated.videoEnd = round3(updated.videoBegin + 0.2);
    }
    if (updated.speed < 0.1) updated.speed = 0.1;
    if (updated.speed > 5) updated.speed = 5;
    return updated;
  });

  // Recompute timeline positions sequentially
  let cursor = 0;
  for (let i = 0; i < newSlots.length; i++) {
    const slot = newSlots[i];
    const clipLen = Math.max(0.1, slot.videoEnd - slot.videoBegin);
    const speed = Math.max(0.1, slot.speed || 1);
    const slotDuration = round3(clipLen / speed);
    slot.enterBegin = round3(cursor);
    slot.exitEnd = round3(cursor + slotDuration);

    const actualOverlap =
      i < newSlots.length - 1 && slot.transition && slot.transitionDuration
        ? round3(Math.min(slot.transitionDuration, slotDuration * 0.4))
        : 0;

    cursor = slot.exitEnd - actualOverlap;
  }

  const finalDuration = round3(newSlots[newSlots.length - 1].exitEnd);

  // Rebuild zvidVisuals
  const zvidVisuals = newSlots.map((slot, idx) => {
    const existing = composed.zvidPayload.visuals[idx] || {};
    return {
      ...existing,
      type: "VIDEO" as const,
      id: `shot_${idx + 1}_${slot.category}`,
      src: slot.src || existing.src || "",
      width: 1080,
      height: 1920,
      resize: "cover" as const,
      position: "center-center" as const,
      videoBegin: slot.videoBegin,
      videoEnd: slot.videoEnd,
      enterBegin: slot.enterBegin,
      exitEnd: slot.exitEnd,
      volume: 0,
      speed: slot.speed,
      flipH: slot.flipH ? true : undefined,
      zoom: slot.zoom || undefined,
      cropParams: slot.cropParams || undefined,
      filter: slot.filter || undefined,
    };
  });

  // Rebuild zvidAudios
  const zvidAudios = composed.zvidPayload.audios ? [...composed.zvidPayload.audios] : [];
  if (voiceTrack && zvidAudios.length > 0) {
    const audioSrc =
      voiceTrack.zvidRemoteUrl ||
      `https://cdn.zvid.io/pending-upload/${encodeURIComponent(voiceTrack.fileName)}`;

    if (voiceTrack.duration > finalDuration && syncMode === "voice_master") {
      const voiceSpeed = round3(
        Math.min(4, Math.max(0.5, voiceTrack.duration / finalDuration))
      );
      zvidAudios[0] = {
        src: audioSrc,
        enter: 0,
        exit: finalDuration,
        audioBegin: 0,
        audioEnd: round3(voiceTrack.duration),
        volume: 1,
        speed: voiceSpeed,
        matchDuration: true,
      };
    } else {
      const audioEndBound = round3(Math.min(voiceTrack.duration, finalDuration));
      zvidAudios[0] = {
        src: audioSrc,
        enter: 0,
        exit: audioEndBound,
        audioBegin: 0,
        audioEnd: audioEndBound,
        volume: 1,
      };
    }
  }

  return {
    ...composed,
    finalDuration,
    totalVisualDuration: finalDuration,
    slots: newSlots,
    zvidPayload: {
      ...composed.zvidPayload,
      duration: finalDuration,
      visuals: zvidVisuals,
      audios: zvidAudios,
    },
    updatedAt: new Date().toISOString(),
  };
}
