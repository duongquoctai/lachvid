import { NextRequest, NextResponse } from "next/server";
import { getSessionIdFromHeaders, sanitizeSessionId } from "@/lib/store";

const PYTHON_BACKEND_URL =
  process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qSessionId = url.searchParams.get("sessionId");
  const headerSessionId = getSessionIdFromHeaders(req.headers);
  const sessionId = sanitizeSessionId(qSessionId || headerSessionId);

  try {
    const pyRes = await fetch(
      `${PYTHON_BACKEND_URL}/render-progress/${encodeURIComponent(sessionId)}`,
      {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      }
    );

    if (!pyRes.ok) {
      return NextResponse.json({
        active: false,
        current: 0,
        total: 0,
        percent: 0,
        current_name: "",
      });
    }

    const data = await pyRes.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({
      active: false,
      current: 0,
      total: 0,
      percent: 0,
      current_name: "",
    });
  }
}
