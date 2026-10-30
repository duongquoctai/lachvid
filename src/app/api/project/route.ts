import { NextRequest, NextResponse } from "next/server";
import {
  readProjectState,
  writeProjectState,
} from "@/lib/store";
import { ProjectState } from "@/types/lachvid";

export async function GET() {
  const state = readProjectState();
  return NextResponse.json({
    state,
    hasEnvApiKey: Boolean(process.env.ZVID_API_KEY),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.state) {
      const saved = writeProjectState(body.state as ProjectState);
      return NextResponse.json({ state: saved });
    }

    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update state" },
      { status: 500 }
    );
  }
}
