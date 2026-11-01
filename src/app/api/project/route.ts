import { NextRequest, NextResponse } from "next/server";
import {
  clearSessionCategories,
  clearSessionSourceVideo,
  getSessionIdFromHeaders,
  readProjectState,
  sanitizeSessionId,
  writeProjectState,
} from "@/lib/store";
import { ProjectState } from "@/types/lachvid";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qSessionId = url.searchParams.get("sessionId");
  const sessionId = sanitizeSessionId(qSessionId || getSessionIdFromHeaders(req.headers));

  const state = readProjectState(sessionId);
  return NextResponse.json({
    sessionId,
    state,
    hasEnvApiKey: Boolean(process.env.ZVID_API_KEY),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = sanitizeSessionId(body.sessionId || getSessionIdFromHeaders(req.headers));

    if (body.action === "reset_source") {
      clearSessionSourceVideo(sessionId);
      const state = readProjectState(sessionId);
      state.sourceVideo = null;
      state.shots = [];
      const saved = writeProjectState(state, sessionId);
      return NextResponse.json({ success: true, sessionId, state: saved });
    }

    if (body.action === "reset_all") {
      clearSessionSourceVideo(sessionId);
      clearSessionCategories(sessionId);
      const state = readProjectState(sessionId);
      state.sourceVideo = null;
      state.shots = [];
      state.categoryPools = {
        open: [],
        product: [],
        texture: [],
        apply: [],
        end: [],
      };
      state.multiVoiceTracks = [];
      state.composedVideos = [];
      const saved = writeProjectState(state, sessionId);
      return NextResponse.json({ success: true, sessionId, state: saved });
    }

    if (body.state) {
      const saved = writeProjectState(body.state as ProjectState, sessionId);
      return NextResponse.json({ sessionId, state: saved });
    }

    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update state" },
      { status: 500 }
    );
  }
}
