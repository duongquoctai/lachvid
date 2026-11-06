import { NextRequest, NextResponse } from "next/server";
import {
  createProject,
  deleteProject,
  getProjectById,
  getProjectCategoryPools,
  getProjectVoiceTracks,
  getProjects,
  getRenderedHistory,
  recordRenderedVideos,
  clearProjectRenderedHistory,
  deleteRenderedHistoryItem,
  updateRenderedHistoryStatus,
} from "@/lib/db";
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
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const history = url.searchParams.get("history");
    const qSessionId = url.searchParams.get("sessionId");

    if (id && history) {
      const records = await getRenderedHistory(id);
      return NextResponse.json({ success: true, history: records });
    }

    if (id) {
      const project = await getProjectById(id);
      if (!project) {
        return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
      }
      const [pools, voices, historyRecords] = await Promise.all([
        getProjectCategoryPools(id),
        getProjectVoiceTracks(id),
        getRenderedHistory(id),
      ]);
      return NextResponse.json({
        success: true,
        project,
        categoryPools: pools,
        voiceTracks: voices,
        renderedCount: historyRecords.length,
      });
    }

    if (qSessionId) {
      const sessionId = sanitizeSessionId(qSessionId);
      const state = readProjectState(sessionId);
      return NextResponse.json({
        sessionId,
        state,
        hasEnvApiKey: Boolean(process.env.ZVID_API_KEY),
      });
    }

    const projects = await getProjects();
    return NextResponse.json({ success: true, projects });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi tải dự án: ${msg}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "create") {
      const name = (body.name as string) || "";
      if (!name.trim()) {
        return NextResponse.json({ error: "Tên dự án không được để trống" }, { status: 400 });
      }
      const desc = (body.description as string) || "";
      const project = await createProject(name, desc);
      return NextResponse.json({ success: true, project });
    }

    if (action === "record_render") {
      const projectId = body.projectId as string;
      const records = body.records as Array<{ tupleKey: string; name?: string; payload?: unknown }>;
      if (!projectId || !records || records.length === 0) {
        return NextResponse.json({ error: "Thiếu dữ liệu ghi nhận render" }, { status: 400 });
      }
      await recordRenderedVideos(projectId, records);
      return NextResponse.json({ success: true, count: records.length, addedCount: records.length });
    }

    if (action === "clear_history") {
      const projectId = body.projectId as string;
      if (!projectId) {
        return NextResponse.json({ error: "Thiếu projectId" }, { status: 400 });
      }
      await clearProjectRenderedHistory(projectId);
      return NextResponse.json({ success: true });
    }

    if (action === "delete_history_item") {
      const id = body.id as string;
      if (!id) {
        return NextResponse.json({ error: "Thiếu id bản ghi" }, { status: 400 });
      }
      await deleteRenderedHistoryItem(id);
      return NextResponse.json({ success: true });
    }

    if (action === "update_render_status") {
      const id = body.id as string;
      const status = body.status === "used" ? "used" : "unused";
      if (!id) {
        return NextResponse.json({ error: "Thiếu id bản ghi" }, { status: 400 });
      }
      await updateRenderedHistoryStatus(id, status);
      return NextResponse.json({ success: true, status });
    }

    if (action === "reset_source") {
      const sessionId = sanitizeSessionId(body.sessionId || getSessionIdFromHeaders(req.headers));
      clearSessionSourceVideo(sessionId);
      const state = readProjectState(sessionId);
      state.sourceVideo = null;
      state.shots = [];
      const saved = writeProjectState(state, sessionId);
      return NextResponse.json({ success: true, sessionId, state: saved });
    }

    if (action === "reset_all") {
      const sessionId = sanitizeSessionId(body.sessionId || getSessionIdFromHeaders(req.headers));
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
      const sessionId = sanitizeSessionId(body.sessionId || getSessionIdFromHeaders(req.headers));
      const saved = writeProjectState(body.state as ProjectState, sessionId);
      return NextResponse.json({ sessionId, state: saved });
    }

    return NextResponse.json({ error: "Hành động không hợp lệ" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi xử lý dự án: ${msg}` }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Thiếu mã dự án cần xóa" }, { status: 400 });
    }
    const ok = await deleteProject(id);
    return NextResponse.json({ success: ok });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi xóa dự án: ${msg}` }, { status: 500 });
  }
}
