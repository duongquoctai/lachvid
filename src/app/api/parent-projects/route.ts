import { NextRequest, NextResponse } from "next/server";
import { getParentProjects, createParentProject } from "@/lib/db";

export async function GET() {
  try {
    const parentProjects = await getParentProjects();
    return NextResponse.json({ parentProjects });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();

    if (!name) {
      return NextResponse.json(
        { error: "Tên dự án không được để trống" },
        { status: 400 }
      );
    }

    const parentProject = await createParentProject(name, description);
    return NextResponse.json({ success: true, parentProject });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
