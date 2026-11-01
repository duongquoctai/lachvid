import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import {
  getSessionIdFromHeaders,
  readProjectState,
  sanitizeSessionId,
} from "@/lib/store";

const PYTHON_BACKEND_URL =
  process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = sanitizeSessionId(body.sessionId || getSessionIdFromHeaders(req.headers));
    const state = readProjectState(sessionId);

    const videoPath = body.filePath || state.sourceVideo?.localPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      return NextResponse.json(
        { error: "Không tìm thấy file video nguồn để cắt cảnh (hoặc phiên làm việc đã hết hạn)." },
        { status: 400 }
      );
    }

    const categoryMinDurations =
      body.categoryMinDurations || state.categoryMinDurations || {};

    const rawScenes = body.scenes || state.shots;
    const scenes = rawScenes.map((s: any) => {
      const minDur = categoryMinDurations[s.category] || null;
      return {
        id: s.id,
        begin: Number(s.begin),
        end: Number(s.end),
        category: s.category,
        label: s.label,
        speed: Number(s.edits?.speed || s.speed || 1.0),
        min_duration: minDur ? Number(minDur) : null,
        flip_h: Boolean(s.edits?.flipH ?? s.flip_h),
        lock_flip_h: Boolean(s.edits?.lockFlipH ?? s.lock_flip_h),
      };
    });

    if (!scenes || scenes.length === 0) {
      return NextResponse.json(
        { error: "Danh sách cảnh cắt rỗng." },
        { status: 400 }
      );
    }

    // Call Python backend
    const pyRes = await fetch(`${PYTHON_BACKEND_URL}/slice-scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_path: videoPath,
        scenes,
        session_id: sessionId,
      }),
    });

    if (!pyRes.ok) {
      const errText = await pyRes.text();
      return NextResponse.json(
        { error: `Python service slice error: ${errText}` },
        { status: pyRes.status }
      );
    }

    // Forward the streaming ZIP file or JSON response
    const contentType = pyRes.headers.get("content-type") || "";
    if (contentType.includes("application/zip")) {
      const zipArrayBuffer = await pyRes.arrayBuffer();
      return new NextResponse(zipArrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="lachvid_categories_${sessionId}.zip"`,
        },
      });
    }

    const data = await pyRes.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Lỗi khi xử lý tách video: ${message}` },
      { status: 500 }
    );
  }
}
