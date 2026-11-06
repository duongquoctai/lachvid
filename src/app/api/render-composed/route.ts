import { NextRequest, NextResponse } from "next/server";
import {
  getSessionIdFromHeaders,
  readProjectState,
  sanitizeSessionId,
} from "@/lib/store";
import { ComposedVideo } from "@/types/lachvid";

const PYTHON_BACKEND_URL =
  process.env.PYTHON_BACKEND_URL || "http://localhost:3006";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const headerSessionId = getSessionIdFromHeaders(req.headers);
    const sessionId = sanitizeSessionId(headerSessionId || body.sessionId);
    const state = readProjectState(sessionId);

    const composedVideos: ComposedVideo[] =
      body.videos ||
      (body.video ? [body.video] : state.composedVideos);

    if (!composedVideos || composedVideos.length === 0) {
      return NextResponse.json(
        { error: "Không có video tổ hợp nào để render." },
        { status: 400 }
      );
    }

    const multiVoicePool = Array.isArray(body.multiVoiceTracks)
      ? body.multiVoiceTracks
      : state.multiVoiceTracks || [];

    // Prepare payload for Python backend
    const videosPayload = composedVideos.map((comp) => {
      let voiceFilePath = "";
      let voiceUrl = "";
      if (comp.voiceTrackId) {
        const found =
          multiVoicePool.find((v: { id: string }) => v.id === comp.voiceTrackId) ||
          state.multiVoiceTracks?.find((v) => v.id === comp.voiceTrackId);
        if (found) {
          voiceFilePath = found.localPath || "";
          voiceUrl = found.localUrl || "";
        } else if (state.voiceTrack?.id === comp.voiceTrackId) {
          voiceFilePath = state.voiceTrack.localPath || "";
          voiceUrl = state.voiceTrack.localUrl || "";
        }
      }

      return {
        id: comp.id,
        name: comp.name,
        voice_file_path: voiceFilePath || undefined,
        voice_url: voiceUrl || undefined,
        slots: comp.slots.map((s) => ({
          category: s.category,
          file_path: s.localPath || undefined,
          url: s.localUrl || s.src || undefined,
          video_begin: Number(s.videoBegin || 0),
          video_end: Number(s.videoEnd || 0),
          speed: Number(s.speed || 1.0),
          flip_h: Boolean(s.flipH),
        })),
      };
    });

    const pyRes = await fetch(`${PYTHON_BACKEND_URL}/render-composed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        videos: videosPayload,
      }),
    });

    if (!pyRes.ok) {
      const errText = await pyRes.text();
      return NextResponse.json(
        { error: `Python service render error: ${errText}` },
        { status: pyRes.status }
      );
    }

    const contentType = pyRes.headers.get("content-type") || "";
    if (contentType.includes("application/zip")) {
      return new NextResponse(pyRes.body, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="lachvid_rendered_${sessionId}.zip"`,
        },
      });
    }

    if (contentType.includes("video/mp4")) {
      const filename = composedVideos[0]?.name ? `${composedVideos[0].name}.mp4` : "rendered.mp4";
      return new NextResponse(pyRes.body, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const data = await pyRes.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Lỗi khi render video: ${message}` },
      { status: 500 }
    );
  }
}
