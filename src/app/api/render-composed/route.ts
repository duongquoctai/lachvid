import { NextRequest, NextResponse } from "next/server";
import { readProjectState } from "@/lib/store";
import { ComposedVideo } from "@/types/lachvid";

const PYTHON_BACKEND_URL =
  process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const state = readProjectState();

    const composedVideos: ComposedVideo[] =
      body.videos ||
      (body.video ? [body.video] : state.composedVideos);

    if (!composedVideos || composedVideos.length === 0) {
      return NextResponse.json(
        { error: "Không có video tổ hợp nào để render." },
        { status: 400 }
      );
    }

    const sessionId = body.sessionId || `render_${Date.now().toString(36)}`;

    // Prepare payload for Python backend
    const videosPayload = composedVideos.map((comp) => {
      // Find voice track if available
      let voiceFilePath = "";
      let voiceUrl = "";
      if (comp.voiceTrackId) {
        const found = state.multiVoiceTracks?.find((v) => v.id === comp.voiceTrackId);
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
