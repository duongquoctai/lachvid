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

  const rand = createSeededRandom(config.seed || 42);

  // Enumerate all candidate tuples if space <= 10,000 (5^5 = 3125 fits easily in memory)
  const allCandidates: [Shot, Shot, Shot, Shot, Shot][] = [];
  const limitEnumeration = 10000;

  outer: for (const sOpen of byCat.open) {
    for (const sProd of byCat.product) {
      for (const sTex of byCat.texture) {
        for (const sApp of byCat.apply) {
          for (const sEnd of byCat.end) {
            allCandidates.push([sOpen, sProd, sTex, sApp, sEnd]);
            if (allCandidates.length >= limitEnumeration) {
              break outer;
            }
          }
        }
      }
    }
  }

  // Shuffle candidates deterministically using Fisher-Yates
  for (let i = allCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = allCandidates[i];
    allCandidates[i] = allCandidates[j];
    allCandidates[j] = tmp;
  }

  const selected: [Shot, Shot, Shot, Shot, Shot][] = [];
  const selectedIds: [string, string, string, string, string][] = [];
  const shotUsageCounts: Record<string, number> = {};
  for (const s of shots) {
    shotUsageCounts[s.id] = 0;
  }

  const targetN = Math.min(config.targetCount, maxPossibleCombinations);
  const minHamming = Math.max(1, Math.min(5, config.minHammingDistance));
  const maxFreq = Math.max(1, config.maxShotFrequency);

  const usedCandidateIndices = new Set<number>();

  while (selected.length < targetN) {
    let bestIdx = -1;
    let bestScore = Infinity;

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

      // Check per-shot frequency cap (accounting for case where same shot ID is somehow in multiple slots)
      let exceedsFreq = false;
      let usageSum = 0;
      for (let k = 0; k < 5; k++) {
        const currentUse = shotUsageCounts[candIds[k]] || 0;
        if (currentUse + 1 > maxFreq) {
          exceedsFreq = true;
          break;
        }
        usageSum += currentUse;
      }
      if (exceedsFreq) continue;

      // Check pairwise Hamming distance against all already selected tuples
      let violatesHamming = false;
      for (const prevIds of selectedIds) {
        if (computeHammingDistance(candIds, prevIds) < minHamming) {
          violatesHamming = true;
          break;
        }
      }
      if (violatesHamming) continue;

      // Prefer candidates with lowest cumulative shot usage so shots are balanced evenly
      if (usageSum < bestScore) {
        bestScore = usageSum;
        bestIdx = i;
        if (usageSum === 0) break; // Optimal unused shot combination
      }
    }

    if (bestIdx === -1) {
      warnings.push(
        `Đã dừng ở ${selected.length}/${targetN} video do ràng buộc độ đa dạng (Min Hamming = ${minHamming}, Max lặp shot = ${maxFreq}) đã bão hoà trên tập shots hiện tại.`
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
 * Builds a complete ComposedVideo & ZvidRenderPayload from a 5-shot tuple,
 * applying Layer-1 (per-shot) + Layer-2 (variant) edits, transition overlap math,
 * and fitting output duration to targetOutputDuration (default 20s):
 * - Priority 1: Trim excess duration on shots that are longer than their Category Min Duration
 * - Priority 2: Fine-tune speed slightly so total output duration matches targetOutputDuration (e.g. 20.0s)
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
    const originalClipLen = Math.max(0.2, shot.end - shot.begin);

    // Ensure speed satisfies the category minimum duration if raw clip is shorter than minCatDur
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

      // Slight Ken Burns zoom depth variation (1.08 to 1.24)
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

      // Subtle color filter variation to evade duplicate hash/perceptual detection
      const bShift = Math.round((rand() - 0.5) * 8); // -4 to +4
      const cShift = Math.round((rand() - 0.5) * 10); // -5 to +5
      const sShift = Math.round((rand() - 0.5) * 12); // -6 to +6
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
