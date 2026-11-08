import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getProjectShares,
  resolveProjectAccess,
  shareProject,
  removeShare,
} from "@/lib/db";
import { DEFAULT_SHARE_PERMISSIONS, ProjectSharePermissions } from "@/types/lachvid";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await context.params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    }

    const access = await resolveProjectAccess(projectId, user.id, user.email);
    if (!access.isOwner) {
      return NextResponse.json(
        { error: "Chỉ chủ sở hữu dự án mới có quyền xem danh sách chia sẻ." },
        { status: 403 }
      );
    }

    const shares = await getProjectShares(projectId);
    return NextResponse.json({ success: true, shares });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await context.params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    }

    const access = await resolveProjectAccess(projectId, user.id, user.email);
    if (!access.isOwner) {
      return NextResponse.json(
        { error: "Chỉ chủ sở hữu dự án mới có quyền chia sẻ dự án này." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const permissions: ProjectSharePermissions =
      body.permissions || DEFAULT_SHARE_PERMISSIONS;

    if (!email) {
      return NextResponse.json(
        { error: "Vui lòng nhập email người nhận." },
        { status: 400 }
      );
    }

    if (email === user.email.toLowerCase()) {
      return NextResponse.json(
        { error: "Bạn không thể tự chia sẻ dự án cho chính mình." },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Định dạng email không hợp lệ." },
        { status: 400 }
      );
    }

    const share = await shareProject(user.id, projectId, email, permissions);
    return NextResponse.json({ success: true, share });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await context.params;
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
    }

    const access = await resolveProjectAccess(projectId, user.id, user.email);
    if (!access.isOwner) {
      return NextResponse.json(
        { error: "Chỉ chủ sở hữu dự án mới có quyền thu hồi chia sẻ." },
        { status: 403 }
      );
    }

    const url = new URL(req.url);
    const shareId = url.searchParams.get("shareId");
    if (!shareId) {
      return NextResponse.json(
        { error: "Thiếu mã định danh chia sẻ (shareId)." },
        { status: 400 }
      );
    }

    const ok = await removeShare(shareId, user.id);
    if (!ok) {
      return NextResponse.json(
        { error: "Không thể thu hồi quyền chia sẻ." },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
