import { NextRequest, NextResponse } from "next/server";
import { getFoldersByParentId, createFolder, getParentProjectById } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const folders = await getFoldersByParentId(id);
    return NextResponse.json({ folders });
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
    const parent = await getParentProjectById(id);
    if (!parent) {
      return NextResponse.json({ error: "Không tìm thấy dự án cha" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();

    if (!name) {
      return NextResponse.json({ error: "Tên folder không được để trống" }, { status: 400 });
    }

    const folder = await createFolder(id, name, description);
    return NextResponse.json({ success: true, folder });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
