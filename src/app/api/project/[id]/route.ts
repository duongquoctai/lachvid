import { NextRequest, NextResponse } from "next/server";
import {
  deleteProject,
  getProjectById,
  getProjectCategoryPools,
  getProjectVoiceTracks,
  getRenderedHistory,
  updateProject,
  updateProjectSettings,
} from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi tải chi tiết dự án: ${msg}` }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const name = body.name ? String(body.name).trim() : undefined;
    const description = typeof body.description === "string" ? body.description : undefined;

    if (name !== undefined && !name) {
      return NextResponse.json({ error: "Tên dự án không được để trống" }, { status: 400 });
    }

    const ok = await updateProject(id, { name, description });
    if (!ok) {
      return NextResponse.json({ error: "Không tìm thấy dự án để cập nhật" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi cập nhật dự án: ${msg}` }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    if (body.settings) {
      await updateProjectSettings(id, body.settings);
      return NextResponse.json({ success: true });
    }

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) {
        return NextResponse.json({ error: "Tên dự án không được để trống" }, { status: 400 });
      }
      const ok = await updateProject(id, { name, description: body.description });
      if (!ok) {
        return NextResponse.json({ error: "Không tìm thấy dự án để cập nhật" }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Thiếu dữ liệu cập nhật" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi cập nhật dự án: ${msg}` }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ok = await deleteProject(id);
    return NextResponse.json({ success: ok });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi xóa dự án: ${msg}` }, { status: 500 });
  }
}
