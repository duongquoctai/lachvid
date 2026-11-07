import { NextRequest, NextResponse } from "next/server";
import {
  getParentProjectById,
  updateParentProject,
  deleteParentProject,
  getFoldersByParentId,
} from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parentProject = await getParentProjectById(id);
    if (!parentProject) {
      return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
    }

    const folders = await getFoldersByParentId(id);
    return NextResponse.json({ parentProject, folders });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    const description = typeof body.description === "string" ? body.description.trim() : undefined;

    if (name !== undefined && !name) {
      return NextResponse.json({ error: "Tên dự án không được để trống" }, { status: 400 });
    }

    const ok = await updateParentProject(id, { name, description });
    if (!ok) {
      return NextResponse.json({ error: "Không tìm thấy dự án để cập nhật" }, { status: 404 });
    }

    const updated = await getParentProjectById(id);
    return NextResponse.json({ success: true, parentProject: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ok = await deleteParentProject(id);
    if (!ok) {
      return NextResponse.json({ error: "Không thể xóa dự án" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
