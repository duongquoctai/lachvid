import { NextRequest, NextResponse } from "next/server";
import {
  deleteProject,
  getFoldersByParentId,
  getProjectById,
  getProjectCategoryPools,
  getProjectVoiceTracks,
  getRenderedHistory,
  resolveFolderAccess,
  updateProject,
  updateProjectSettings,
} from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    const access = await resolveFolderAccess(id, user?.id, user?.email);

    if (access.role === "none") {
      return NextResponse.json(
        { error: "Bạn không có quyền truy cập folder này." },
        { status: 403 }
      );
    }

    const project = await getProjectById(id);
    if (!project) {
      return NextResponse.json({ error: "Không tìm thấy folder." }, { status: 404 });
    }

    const [pools, voices, historyRecords, siblingFolders] = await Promise.all([
      getProjectCategoryPools(id),
      getProjectVoiceTracks(id),
      getRenderedHistory(id),
      project.parentProjectId ? getFoldersByParentId(project.parentProjectId) : Promise.resolve([]),
    ]);

    return NextResponse.json({
      success: true,
      project,
      categoryPools: pools,
      voiceTracks: voices,
      renderedCount: historyRecords.length,
      access,
      siblingFolders: siblingFolders.map((f) => ({
        id: f.id,
        name: f.name,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi tải chi tiết folder: ${msg}` }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    const access = await resolveFolderAccess(id, user?.id, user?.email);

    if (!access.canManageFolders) {
      return NextResponse.json(
        { error: "Bạn không có quyền đổi tên folder này (yêu cầu quyền Chỉnh sửa)." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const name = body.name ? String(body.name).trim() : undefined;
    const description = typeof body.description === "string" ? body.description : undefined;

    if (name !== undefined && !name) {
      return NextResponse.json({ error: "Tên folder không được để trống." }, { status: 400 });
    }

    const ok = await updateProject(id, { name, description });
    if (!ok) {
      return NextResponse.json({ error: "Không tìm thấy folder để cập nhật." }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi cập nhật folder: ${msg}` }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    const access = await resolveFolderAccess(id, user?.id, user?.email);

    if (access.role === "none") {
      return NextResponse.json(
        { error: "Bạn không có quyền truy cập folder này." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));

    if (body.settings) {
      // Cho phép cập nhật cài đặt nếu có quyền chỉnh sửa ít nhất 1 module
      if (!access.canManageFolders) {
        return NextResponse.json(
          { error: "Bạn không có quyền thay đổi cài đặt của folder." },
          { status: 403 }
        );
      }
      await updateProjectSettings(id, body.settings);
      return NextResponse.json({ success: true });
    }

    if (body.name !== undefined) {
      if (!access.canManageFolders) {
        return NextResponse.json(
          { error: "Bạn không có quyền đổi tên folder này." },
          { status: 403 }
        );
      }
      const name = String(body.name).trim();
      if (!name) {
        return NextResponse.json({ error: "Tên folder không được để trống." }, { status: 400 });
      }
      const ok = await updateProject(id, { name, description: body.description });
      if (!ok) {
        return NextResponse.json({ error: "Không tìm thấy folder để cập nhật." }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Thiếu dữ liệu cập nhật." }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi cập nhật folder: ${msg}` }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    const access = await resolveFolderAccess(id, user?.id, user?.email);

    if (!access.canManageFolders) {
      return NextResponse.json(
        { error: "Bạn không có quyền xóa folder này." },
        { status: 403 }
      );
    }

    const ok = await deleteProject(id);
    return NextResponse.json({ success: ok });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi xóa folder: ${msg}` }, { status: 500 });
  }
}
