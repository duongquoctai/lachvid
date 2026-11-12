import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_ALLOWED_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

export async function POST(req: NextRequest) {
  try {
    cleanupExpiredSessions();

    // -------------------------------------------------------------
    // CHẾ ĐỘ 1: CHUNKED STREAMING (Vượt giới hạn Cloudflare 100MB)
    // -------------------------------------------------------------
    const uploadId = req.headers.get("x-upload-id");
    const chunkIndexHeader = req.headers.get("x-chunk-index");

    if (uploadId && chunkIndexHeader !== null) {
      const chunkIndex = parseInt(chunkIndexHeader, 10);
      const totalChunks = parseInt(req.headers.get("x-total-chunks") || "1", 10);
      const rawFileName = req.headers.get("x-file-name") || "video.mp4";
      const fileName = decodeURIComponent(rawFileName);
      const fileSize = parseInt(req.headers.get("x-file-size") || "0", 10);
      const kind = (req.headers.get("x-upload-kind") as string) || "source";
      const duration = Number(req.headers.get("x-video-duration") || 38);
      const width = Number(req.headers.get("x-video-width") || 1080);
      const height = Number(req.headers.get("x-video-height") || 1920);

      const sessionId = sanitizeSessionId(
        req.headers.get("x-session-id") || getSessionIdFromHeaders(req.headers)
      );

      if (fileSize > MAX_ALLOWED_FILE_SIZE) {
        return NextResponse.json(
          { error: `File vượt quá giới hạn tối đa cho phép (${MAX_ALLOWED_FILE_SIZE / 1024 / 1024} MB).` },
          { status: 413 }
        );
      }

      const sessionPaths = ensureSessionDirs(sessionId);
      const safeUploadId = uploadId.replace(/[^a-zA-Z0-9_-]/g, "");
      const safeBase = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const targetDir = kind === "voice" ? sessionPaths.voicesDir : sessionPaths.sourceDir;

      const partPath = path.join(targetDir, `${safeUploadId}.part`);
      const finalFileName = `${safeUploadId}_${safeBase}`;
      const finalDestPath = path.join(targetDir, finalFileName);

      // Nếu là chunk đầu tiên (chunk 0) của source video, dọn dẹp file cũ
      if (chunkIndex === 0) {
        if (kind === "source") {
          clearSessionSourceVideo(sessionId);
        }
        if (fs.existsSync(partPath)) {
          fs.unlinkSync(partPath);
        }
      }

      if (!req.body) {
        return NextResponse.json({ error: "Không tìm thấy dữ liệu chunk stream." }, { status: 400 });
      }

      // Stream trực tiếp body của chunk xuống file .part bằng cờ append (Zero RAM)
      const nodeStream = Readable.fromWeb(req.body as any);
      const writeStream = fs.createWriteStream(partPath, {
        flags: chunkIndex === 0 ? "w" : "a",
      });
      await pipeline(nodeStream, writeStream);

      // Nếu chưa phải chunk cuối cùng -> Báo nhận thành công để client gửi tiếp
      if (chunkIndex < totalChunks - 1) {
        const stats = fs.statSync(partPath);
        return NextResponse.json({
          partial: true,
          chunkIndex,
          totalChunks,
          receivedBytes: stats.size,
        });
      }

      // Khi đã nhận đủ chunk cuối cùng -> Rename .part thành file hoàn chỉnh
      if (fs.existsSync(finalDestPath)) {
        fs.unlinkSync(finalDestPath);
      }
      fs.renameSync(partPath, finalDestPath);

      const finalStats = fs.statSync(finalDestPath);
      const state = readProjectState(sessionId);

      if (kind === "voice") {
        const voiceTrack: VoiceTrack = {
          id: `voice_${Date.now()}`,
          name: fileName.replace(/\.[^.]+$/, ""),
          fileName: finalFileName,
          localUrl: `/api/media/sessions/${sessionId}/voices/${finalFileName}`,
          localPath: finalDestPath,
          sizeBytes: finalStats.size,
          duration: duration > 0 ? Math.round(duration * 100) / 100 : 15,
          zvidUploadId: null,
          zvidRemoteUrl: null,
          zvidUploadedAt: null,
          createdAt: new Date().toISOString(),
        };
        state.voiceTrack = voiceTrack;
        writeProjectState(state, sessionId);
        return NextResponse.json({ state, voiceTrack, sessionId, completed: true });
      }

      // Kind là source video
      const sourceVideo: SourceVideo = {
        id: `src_${Date.now()}`,
        name: fileName.replace(/\.[^.]+$/, ""),
        fileName: finalFileName,
        localUrl: `/api/media/sessions/${sessionId}/source/${finalFileName}`,
        localPath: finalDestPath,
        sizeBytes: finalStats.size,
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

      return NextResponse.json({ state, sourceVideo, sessionId, completed: true });
    }

    // -------------------------------------------------------------
    // CHẾ ĐỘ 2: MULTIPART FORM-DATA (Fallback tương thích)
    // -------------------------------------------------------------
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const kind = (formData.get("kind") as string) || "video";
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

    if (file.size > MAX_ALLOWED_FILE_SIZE) {
      return NextResponse.json(
        { error: `File vượt quá giới hạn tối đa cho phép (${MAX_ALLOWED_FILE_SIZE / 1024 / 1024} MB).` },
        { status: 413 }
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

    // Source video
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
