import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUsers } from "@/lib/db";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return NextResponse.json(
        { error: "Vui lòng đăng nhập để truy cập." },
        { status: 401 }
      );
    }

    const users = await listUsers(currentUser.id);
    return NextResponse.json({ users });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
