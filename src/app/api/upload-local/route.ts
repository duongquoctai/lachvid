import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  cleanupExpiredSessions,
  clearSessionSourceVideo,
  ensureSessionDirs,
  getSessionIdFromHeaders,
  readProjectState,
  sanitizeSessionId,
  writeProjectState,
} from "@/lib/store";
import {
  DEFAULT_CATEGORY_MIN_DURATIONS,
  SourceVideo,
  VoiceTrack,
} from "@/types/lachvid";

export async function POST(req: NextRequest) {
  try {
    // Proactively clean up expired sessions
    cleanupExpiredSessions();

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const kind = (formData.get("kind") as string) || "video"; // "video" | "voice" | "source"
    const duration = Number(formData.get("duration") || 38);
    const width = Number(formData.get("width") || 1080);
    const height = Number(formData.get("height") || 1920);

    const formSessionId = formData.get("sessionId") as string | null;
    const sessionId = sanitizeSessionId(formSessionId || getSessionIdFromHeaders(req.headers));

    if (!file) {
      return NextResponse.json(
        { error: "Vui lòng đính kèm file upload." },
        { status: 400 }
      );
    }

    const sessionPaths = ensureSessionDirs(sessionId);
    const safeBase = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueName = `${Date.now()}_${safeBase}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const state = readProjectState(sessionId);

    if (kind === "voice") {
      const destPath = path.join(sessionPaths.voicesDir, uniqueName);
      fs.writeFileSync(destPath, buffer);

      const voiceTrack: VoiceTrack = {
        id: `voice_${Date.now()}`,
        name: file.name.replace(/\.[^.]+$/, ""),
        fileName: uniqueName,
        localUrl: `/api/media/sessions/${sessionId}/voices/${uniqueName}`,
        localPath: destPath,
        sizeBytes: file.size,
        duration: duration > 0 ? Math.round(duration * 100) / 100 : 15,
        zvidUploadId: null,
        zvidRemoteUrl: null,
        zvidUploadedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.voiceTrack = voiceTrack;
      writeProjectState(state, sessionId);
      return NextResponse.json({ state, voiceTrack, sessionId });
    }

    // Kind is source video
    // RULE: Only 1 original video is kept in sourceDir at any time. Purge previous ones.
    clearSessionSourceVideo(sessionId);

    const destPath = path.join(sessionPaths.sourceDir, uniqueName);
    fs.writeFileSync(destPath, buffer);

    const sourceVideo: SourceVideo = {
      id: `src_${Date.now()}`,
      name: file.name.replace(/\.[^.]+$/, ""),
      fileName: uniqueName,
      localUrl: `/api/media/sessions/${sessionId}/source/${uniqueName}`,
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
    writeProjectState(state, sessionId);

    return NextResponse.json({ state, sourceVideo, sessionId });
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
