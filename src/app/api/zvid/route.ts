import { NextRequest, NextResponse } from "next/server";
import { readProjectState, writeProjectState } from "@/lib/store";
import {
  fetchZvidSchemaAndLimits,
  getZvidJobStatusAndPersist,
  listZvidUploads,
  submitZvidRenderJob,
  uploadFileToZvid,
  validateZvidRender,
} from "@/lib/zvid";
import { buildComposedVideo } from "@/lib/planner";
import { Shot } from "@/types/lachvid";

/**
 * Ensures the single source video and (optional) final voice track are uploaded to Zvid (`POST /api/uploads`)
 * if they don't yet have a cached `zvidRemoteUrl`. Then refreshes composed payloads with the live CDN URLs.
 */
async function ensureAssetsUploadedAndRefreshPayloads(apiKey?: string) {
  const state = readProjectState();
  if (!state.sourceVideo) {
    throw new Error("Chưa có source video.");
  }

  let changed = false;

  if (!state.sourceVideo.zvidRemoteUrl && state.sourceVideo.localPath) {
    const uploaded = await uploadFileToZvid({
      localPath: state.sourceVideo.localPath,
      fileName: state.sourceVideo.fileName,
      mimeType: "video/mp4",
      apiKey,
    });
    state.sourceVideo.zvidUploadId = uploaded.id;
    state.sourceVideo.zvidRemoteUrl = uploaded.url;
    state.sourceVideo.zvidUploadedAt =
      uploaded.createdAt || new Date().toISOString();
    changed = true;
  }

  if (
    state.voiceTrack &&
    !state.voiceTrack.zvidRemoteUrl &&
    state.voiceTrack.localPath
  ) {
    const uploadedVoice = await uploadFileToZvid({
      localPath: state.voiceTrack.localPath,
      fileName: state.voiceTrack.fileName,
      mimeType: "audio/mpeg",
      apiKey,
    });
    state.voiceTrack.zvidUploadId = uploadedVoice.id;
    state.voiceTrack.zvidRemoteUrl = uploadedVoice.url;
    state.voiceTrack.zvidUploadedAt =
      uploadedVoice.createdAt || new Date().toISOString();
    changed = true;
  }

  if (changed) {
    const isPoolMix = Boolean(
      state.categoryPools &&
        Object.values(state.categoryPools).some((p) => p && p.length > 0)
    );
    const shotMap = new Map<string, Shot>();
    for (const s of state.shots) {
      shotMap.set(s.id, s);
    }
    if (state.categoryPools) {
      const cats: Array<"open" | "product" | "texture" | "apply" | "end"> = [
        "open",
        "product",
        "texture",
        "apply",
        "end",
      ];
      for (const cat of cats) {
        for (const item of state.categoryPools[cat] || []) {
          shotMap.set(item.id, {
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
    }

    state.composedVideos = state.composedVideos.map((comp, idx) => {
      const tupleShots = comp.shotIds.map((id) => shotMap.get(id));
      if (tupleShots.every(Boolean)) {
        const tupleTyped = tupleShots as [Shot, Shot, Shot, Shot, Shot];
        const rebuilt = buildComposedVideo({
          index: idx,
          tuple: tupleTyped,
          sourceVideo: state.sourceVideo || {
            id: "pool_mix",
            name: "Category Pool Mix",
            fileName: "pool_mix.mp4",
            localUrl: tupleTyped[0]?.edits?.customLocalUrl || "",
            localPath: "",
            sizeBytes: 0,
            duration: 20,
            width: 1080,
            height: 1920,
            createdAt: new Date().toISOString(),
          },
          voiceTrack: state.voiceTrack,
          syncMode: state.syncMode,
          diversityConfig: state.diversityConfig,
          categoryMinDurations: state.categoryMinDurations,
          existingJobId: comp.jobId,
          existingId: comp.id,
          preserveOriginalClips: isPoolMix,
        });
        return {
          ...rebuilt,
          name: comp.name,
        };
      }
      return comp;
    });

    writeProjectState(state);
  }

  return state;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, apiKey, videoIds } = body as {
      action:
        | "check_schema_and_uploads"
        | "lazy_upload_and_validate"
        | "submit_batch_render"
        | "poll_active_jobs";
      apiKey?: string;
      videoIds?: string[];
    };

    if (action === "check_schema_and_uploads") {
      const [schemaRes, uploadsRes] = await Promise.all([
        fetchZvidSchemaAndLimits(apiKey),
        listZvidUploads(apiKey),
      ]);
      const state = readProjectState();
      state.zvidPlanLimits = schemaRes.planLimits;
      state.zvidUploadUsage = uploadsRes.usage;
      writeProjectState(state);

      return NextResponse.json({
        state,
        schemaVersion: schemaRes.schemaVersion,
        planLimits: schemaRes.planLimits,
        uploadUsage: uploadsRes.usage,
      });
    }

    if (action === "lazy_upload_and_validate") {
      const state = await ensureAssetsUploadedAndRefreshPayloads(apiKey);
      const targetSet =
        Array.isArray(videoIds) && videoIds.length > 0
          ? new Set(videoIds)
          : new Set(state.composedVideos.map((v) => v.id));

      let totalCredits = 0;
      for (let i = 0; i < state.composedVideos.length; i++) {
        const comp = state.composedVideos[i];
        if (!targetSet.has(comp.id)) continue;

        const res = await validateZvidRender({
          payload: comp.zvidPayload,
          jobId: comp.jobId,
          apiKey,
        });

        comp.validation = {
          valid: res.valid,
          creditsRequired: res.creditsRequired,
          warnings: res.warnings || [],
          checkedAt: new Date().toISOString(),
          error: "error" in res ? res.error : undefined,
        };
        comp.renderState = res.valid ? "validated" : "ValidationFailed";
        comp.updatedAt = new Date().toISOString();
        totalCredits += res.creditsRequired;
      }

      // Also refresh upload usage stats after lazy upload
      try {
        const uploadsRes = await listZvidUploads(apiKey);
        state.zvidUploadUsage = uploadsRes.usage;
      } catch {
        // Ignore non-critical usage fetch error
      }

      writeProjectState(state);
      return NextResponse.json({ state, totalCredits });
    }

    if (action === "submit_batch_render") {
      const state = await ensureAssetsUploadedAndRefreshPayloads(apiKey);
      const targetSet =
        Array.isArray(videoIds) && videoIds.length > 0
          ? new Set(videoIds)
          : new Set(state.composedVideos.map((v) => v.id));

      for (let i = 0; i < state.composedVideos.length; i++) {
        const comp = state.composedVideos[i];
        if (!targetSet.has(comp.id)) continue;
        if (comp.renderState === "completed" || comp.renderState === "queued") {
          continue;
        }

        // Enforce rule: ALWAYS validate before submit
        if (!comp.validation?.valid) {
          const valRes = await validateZvidRender({
            payload: comp.zvidPayload,
            jobId: comp.jobId,
            apiKey,
          });
          comp.validation = {
            valid: valRes.valid,
            creditsRequired: valRes.creditsRequired,
            warnings: valRes.warnings || [],
            checkedAt: new Date().toISOString(),
            error: "error" in valRes ? valRes.error : undefined,
          };
          if (!valRes.valid) {
            comp.renderState = "ValidationFailed";
            comp.failedReason = comp.validation.error || "Validation failed";
            continue;
          }
        }

        try {
          const submitRes = await submitZvidRenderJob({
            payload: comp.zvidPayload,
            jobId: comp.jobId,
            apiKey,
          });
          comp.jobId = submitRes.jobId;
          comp.renderState = "queued";
          comp.creditsReserved = submitRes.creditsReserved;
          comp.progress = 5;
          comp.updatedAt = new Date().toISOString();
        } catch (err) {
          comp.renderState = "failed";
          comp.failedReason =
            err instanceof Error ? err.message : "Submit failed";
          comp.updatedAt = new Date().toISOString();
        }
      }

      writeProjectState(state);
      return NextResponse.json({ state });
    }

    if (action === "poll_active_jobs") {
      const state = readProjectState();
      for (let i = 0; i < state.composedVideos.length; i++) {
        const comp = state.composedVideos[i];
        if (
          comp.renderState !== "queued" &&
          comp.renderState !== "active"
        ) {
          continue;
        }
        try {
          const status = await getZvidJobStatusAndPersist({
            jobId: comp.jobId,
            apiKey,
          });
          if (status.state === "completed") {
            comp.renderState = "completed";
            comp.progress = 100;
            comp.remoteResultUrl = status.remoteResultUrl;
            comp.localOutputUrl = status.localOutputUrl;
            comp.outputExpiresAt = status.outputExpiresAt;
          } else if (status.state === "failed") {
            comp.renderState = "failed";
            comp.failedReason = status.failedReason || "Render failed on Zvid";
          } else {
            comp.renderState = "active";
            comp.progress = Math.max(10, status.progress || 15);
          }
          comp.updatedAt = new Date().toISOString();
        } catch {
          // Keep current state on transient network poll glitch
        }
      }
      writeProjectState(state);
      return NextResponse.json({ state });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Zvid API error" },
      { status: 500 }
    );
  }
}
