import { NextRequest, NextResponse } from "next/server";
import {
  getSessionIdFromHeaders,
  readProjectState,
  sanitizeSessionId,
  writeProjectState,
} from "@/lib/store";
import {
  CATEGORY_ORDER,
  buildComposedVideo,
  planDiverseCombinations,
} from "@/lib/planner";
import {
  AudioVideoSyncMode,
  CategoryPools,
  ComposedVideo,
  DiversityConfig,
  MultiVoiceItem,
  Shot,
  VoiceTrack,
} from "@/types/lachvid";
import { getRenderedHistory } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = sanitizeSessionId(body.sessionId || getSessionIdFromHeaders(req.headers));
    const projectId = (body.projectId as string) || "";
    const state = readProjectState(sessionId);

    const pools: CategoryPools = body.categoryPools || state.categoryPools || {
      open: [],
      product: [],
      texture: [],
      apply: [],
      end: [],
    };

    // Build Shot[] pool from CategoryPools
    const poolShots: Shot[] = [];
    for (const cat of CATEGORY_ORDER) {
      const items = pools[cat] || [];
      for (const item of items) {
        poolShots.push({
          id: item.id,
          sourceVideoId: item.id,
          label: item.name || item.fileName,
          begin: 0,
          end: item.duration || 4.0,
          category: cat,
          contentHash: item.contentHash,
          edits: {
            speed: 1,
            flipH: false,
            lockFlipH: Boolean(item.lockFlipH),
            zoom: false,
            transition: null,
            transitionDuration: 0,
            customSrc: item.zvidRemoteUrl || item.localUrl,
            customLocalUrl: item.localUrl,
            customLocalPath: item.localPath,
          },
        });
      }
    }

    // Fallback to shots from Module 1 if pools are empty
    const shotsToUse = poolShots.length >= 5 ? poolShots : state.shots;

    if (shotsToUse.length === 0) {
      return NextResponse.json(
        { error: "Chưa có video trong 5 Category để tạo tổ hợp trộn." },
        { status: 400 }
      );
    }

    const isCategoryPool = poolShots.length >= 5;
    const preserveOriginalClips =
      body.preserveOriginalClips !== undefined
        ? Boolean(body.preserveOriginalClips)
        : isCategoryPool;

    const diversityConfig: DiversityConfig = {
      ...state.diversityConfig,
      ...(body.diversityConfig || {}),
      targetOutputDuration: Number(
        body.diversityConfig?.targetOutputDuration ||
          state.diversityConfig.targetOutputDuration ||
          20
      ),
      targetCount: Math.min(
        50,
        Math.max(
          1,
          Number(
            body.diversityConfig?.targetCount ||
              state.diversityConfig.targetCount ||
              3
          )
        )
      ),
      enableAutoVariantEdits:
        isCategoryPool || preserveOriginalClips
          ? false
          : Boolean(
              body.diversityConfig?.enableAutoVariantEdits ??
                state.diversityConfig.enableAutoVariantEdits
            ),
      randomTransitionDuration:
        isCategoryPool || preserveOriginalClips
          ? 0
          : Number(
              body.diversityConfig?.randomTransitionDuration ??
                state.diversityConfig.randomTransitionDuration ??
                0
            ),
    };

    // Load rendered history if projectId provided
    let historyTuples: string[] = [];
    if (projectId) {
      const records = await getRenderedHistory(projectId);
      historyTuples = records.map((r) => r.tupleKey);
    }

    const plan = planDiverseCombinations(shotsToUse, diversityConfig, historyTuples);
    if (plan.tuples.length === 0) {
      return NextResponse.json(
        {
          error:
            plan.warnings.join(" | ") ||
            "Không thể tạo tổ hợp. Hãy đảm bảo mỗi Category có ít nhất 1 video.",
          warnings: plan.warnings,
        },
        { status: 400 }
      );
    }

    const syncMode: AudioVideoSyncMode = body.syncMode || state.syncMode || "video_master";

    // Multi-voice distribution (balanced round-robin + unique pairing with OPEN hook)
    const mixVoiceMode: "none" | "rotate" = body.mixVoiceMode ?? "rotate";
    const multiVoices: MultiVoiceItem[] = body.multiVoiceTracks || state.multiVoiceTracks || [];
    const hasVoices = mixVoiceMode === "rotate" && multiVoices.length > 0;

    const voiceUsageCounts: Record<string, number> = {};
    const openVoicePairCounts: Record<string, number> = {};
    let lastVoiceId: string | null = null;

    const composedVideos: ComposedVideo[] = plan.tuples.map((tuple, index) => {
      let voiceForThisVideo: VoiceTrack | null = null;
      if (hasVoices) {
        const openId = tuple[0]?.id || "open";
        let bestVoice = multiVoices[index % multiVoices.length];
        let bestVoiceScore = Infinity;

        for (let vIdx = 0; vIdx < multiVoices.length; vIdx++) {
          const candidateVoice = multiVoices[(index + vIdx) % multiVoices.length];
          const vUse = voiceUsageCounts[candidateVoice.id] || 0;
          const pairKey = `${openId}|${candidateVoice.id}`;
          const pairUse = openVoicePairCounts[pairKey] || 0;
          const repeatPenalty =
            multiVoices.length > 1 && candidateVoice.id === lastVoiceId ? 200 : 0;
          const score = vUse * 100 + pairUse * 60 + repeatPenalty;
          if (score < bestVoiceScore) {
            bestVoiceScore = score;
            bestVoice = candidateVoice;
          }
        }

        voiceUsageCounts[bestVoice.id] = (voiceUsageCounts[bestVoice.id] || 0) + 1;
        openVoicePairCounts[`${openId}|${bestVoice.id}`] =
          (openVoicePairCounts[`${openId}|${bestVoice.id}`] || 0) + 1;
        lastVoiceId = bestVoice.id;

        voiceForThisVideo = {
          id: bestVoice.id,
          name: bestVoice.name,
          fileName: bestVoice.fileName,
          localUrl: bestVoice.localUrl,
          localPath: bestVoice.localPath || "",
          sizeBytes: 0,
          duration: bestVoice.duration || 20,
          createdAt: new Date().toISOString(),
        };
      } else if (mixVoiceMode !== "none" && state.voiceTrack) {
        voiceForThisVideo = state.voiceTrack;
      }

      return buildComposedVideo({
        index,
        tuple,
        sourceVideo: state.sourceVideo || {
          id: "pool_mix",
          name: "Category Pool Mix",
          fileName: "pool_mix.mp4",
          localUrl: tuple[0].edits.customLocalUrl || "",
          localPath: "",
          sizeBytes: 0,
          duration: 20,
          width: 1080,
          height: 1920,
          createdAt: new Date().toISOString(),
        },
        voiceTrack: voiceForThisVideo,
        syncMode,
        diversityConfig,
        categoryMinDurations: state.categoryMinDurations,
        preserveOriginalClips,
      });
    });

    state.categoryPools = pools;
    state.multiVoiceTracks = multiVoices;
    state.composedVideos = composedVideos;
    state.diversityConfig = diversityConfig;
    writeProjectState(state, sessionId);

    return NextResponse.json({
      success: true,
      sessionId,
      totalComposed: composedVideos.length,
      composedVideos,
      warnings: plan.warnings,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Lỗi khi tạo tổ hợp video trộn: ${msg}` },
      { status: 500 }
    );
  }
}
