import { NextRequest, NextResponse } from "next/server";
import { getParentProjects, createParentProject, getDatabaseStatus } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await getCurrentUser();
    const parentProjects = await getParentProjects(user?.id, user?.email);
    const dbStatus = getDatabaseStatus();
    return NextResponse.json({ parentProjects, currentUser: user, dbStatus });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: "Vui lòng đăng nhập để tạo dự án mới." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();

    if (!name) {
      return NextResponse.json(
        { error: "Tên dự án không được để trống." },
        { status: 400 }
      );
    }

    const parentProject = await createParentProject(name, description, user.id);
    return NextResponse.json({ success: true, parentProject });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
