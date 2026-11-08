import { NextRequest, NextResponse } from "next/server";
import {
  getFoldersByParentId,
  createFolder,
  getParentProjectById,
  resolveProjectAccess,
} from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    const access = await resolveProjectAccess(id, user?.id, user?.email);

    if (access.role === "none") {
      return NextResponse.json(
        { error: "Bạn không có quyền truy cập dự án này." },
        { status: 403 }
      );
    }

    const folders = await getFoldersByParentId(id);
    return NextResponse.json({ folders, access });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    const access = await resolveProjectAccess(id, user?.id, user?.email);

    if (!access.canManageFolders) {
      return NextResponse.json(
        { error: "Bạn không có quyền tạo folder trong dự án này (yêu cầu quyền Chỉnh sửa)." },
        { status: 403 }
      );
    }

    const parent = await getParentProjectById(id);
    if (!parent) {
      return NextResponse.json({ error: "Không tìm thấy dự án." }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();

    if (!name) {
      return NextResponse.json({ error: "Tên folder không được để trống." }, { status: 400 });
    }

    const folder = await createFolder(id, name, description);
    return NextResponse.json({ success: true, folder });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
