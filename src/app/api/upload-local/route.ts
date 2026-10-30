import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  ensureDataDirs,
  readProjectState,
  UPLOADS_DIR,
  writeProjectState,
} from "@/lib/store";
import {
  DEFAULT_CATEGORY_MIN_DURATIONS,
  SourceVideo,
  VoiceTrack,
} from "@/types/lachvid";

export async function POST(req: NextRequest) {
  try {
    ensureDataDirs();
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const kind = (formData.get("kind") as string) || "video"; // "video" | "voice"
    const duration = Number(formData.get("duration") || 38);
    const width = Number(formData.get("width") || 1080);
    const height = Number(formData.get("height") || 1920);

    if (!file) {
      return NextResponse.json(
        { error: "Vui lòng đính kèm file upload." },
        { status: 400 }
      );
    }

    const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueName = `${Date.now()}_${safeBase}`;
    const destPath = path.join(UPLOADS_DIR, uniqueName);

    const arrayBuffer = await file.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));

    const state = readProjectState();

    if (kind === "voice") {
      const voiceTrack: VoiceTrack = {
        id: `voice_${Date.now()}`,
        name: file.name.replace(/\.[^.]+$/, ""),
        fileName: uniqueName,
        localUrl: `/api/media/uploads/${uniqueName}`,
        localPath: destPath,
        sizeBytes: file.size,
        duration: duration > 0 ? Math.round(duration * 100) / 100 : 15,
        zvidUploadId: null,
        zvidRemoteUrl: null,
        zvidUploadedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.voiceTrack = voiceTrack;
      writeProjectState(state);
      return NextResponse.json({ state, voiceTrack });
    }

    const sourceVideo: SourceVideo = {
      id: `src_${Date.now()}`,
      name: file.name.replace(/\.[^.]+$/, ""),
      fileName: uniqueName,
      localUrl: `/api/media/uploads/${uniqueName}`,
      localPath: destPath,
      sizeBytes: file.size,
      duration: duration > 0 ? Math.round(duration * 100) / 100 : 38,
      width: width || 1080,
      height: height || 1920,
      zvidUploadId: null,
      zvidRemoteUrl: null,
      zvidUploadedAt: null,
      createdAt: new Date().toISOString(),
    };

    state.sourceVideo = sourceVideo;
    state.categoryMinDurations = {
      ...DEFAULT_CATEGORY_MIN_DURATIONS,
      ...(state.categoryMinDurations || {}),
    };
    state.shots = [];
    state.composedVideos = [];
    writeProjectState(state);

    return NextResponse.json({ state, sourceVideo });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Lỗi khi lưu file lên máy local",
      },
      { status: 500 }
    );
  }
}
