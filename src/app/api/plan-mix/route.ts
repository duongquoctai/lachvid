import { NextRequest, NextResponse } from "next/server";
import { readProjectState, writeProjectState } from "@/lib/store";
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
  Shot,
  VoiceTrack,
} from "@/types/lachvid";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const state = readProjectState();

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

    const diversityConfig: DiversityConfig = {
      ...state.diversityConfig,
      ...(body.diversityConfig || {}),
      targetOutputDuration: Number(
        body.diversityConfig?.targetOutputDuration ||
          state.diversityConfig.targetOutputDuration ||
          20
      ),
      targetCount: Number(
        body.diversityConfig?.targetCount ||
          state.diversityConfig.targetCount ||
          3
      ),
    };

    const plan = planDiverseCombinations(shotsToUse, diversityConfig);
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

    // Multi-voice distribution
    const multiVoices = state.multiVoiceTracks || [];
    const hasVoices = multiVoices.length > 0;

    const composedVideos: ComposedVideo[] = plan.tuples.map((tuple, index) => {
      let voiceForThisVideo: VoiceTrack | null = state.voiceTrack;
      if (hasVoices) {
        const chosenVoice = multiVoices[index % multiVoices.length];
        voiceForThisVideo = {
          id: chosenVoice.id,
          name: chosenVoice.name,
          fileName: chosenVoice.fileName,
          localUrl: chosenVoice.localUrl,
          localPath: chosenVoice.localPath || "",
          sizeBytes: 0,
          duration: chosenVoice.duration || 20,
          createdAt: new Date().toISOString(),
        };
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
      });
    });

    state.composedVideos = composedVideos;
    state.diversityConfig = diversityConfig;
    writeProjectState(state);

    return NextResponse.json({
      success: true,
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
