import { NextRequest, NextResponse } from "next/server";
import {
  deleteProject,
  getProjectById,
  getProjectCategoryPools,
  getRenderedHistory,
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
    const pools = await getProjectCategoryPools(id);
    const historyRecords = await getRenderedHistory(id);

    return NextResponse.json({
      success: true,
      project,
      categoryPools: pools,
      renderedCount: historyRecords.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi tải chi tiết dự án: ${msg}` }, { status: 500 });
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
    return NextResponse.json({ error: "Thiếu dữ liệu settings" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi lưu settings: ${msg}` }, { status: 500 });
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
