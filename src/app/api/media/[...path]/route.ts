import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  BASE_SESSIONS_DIR,
  DATA_DIR,
  touchSession,
} from "@/lib/store";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  if (!segments || segments.length === 0) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }

  let filePath = "";

  // Check if first segment is "sessions" (e.g. /api/media/sessions/{sessionId}/...)
  if (segments[0] === "sessions") {
    filePath = path.resolve(BASE_SESSIONS_DIR, ...segments.slice(1));
    if (segments[1]) {
      touchSession(segments[1]);
    }
  } else {
    // Try in BASE_SESSIONS_DIR first if it matches
    const testSessionPath = path.resolve(BASE_SESSIONS_DIR, ...segments);
    if (fs.existsSync(testSessionPath)) {
      filePath = testSessionPath;
    } else {
      // Fallback to legacy DATA_DIR
      filePath = path.resolve(DATA_DIR, ...segments);
      if (!fs.existsSync(filePath) && segments[0] === "slices") {
        const fallbackPath = path.resolve(DATA_DIR, "outputs", ...segments);
        if (fs.existsSync(fallbackPath)) {
          filePath = fallbackPath;
        }
      }
    }
  }

  // Security check: must reside inside BASE_SESSIONS_DIR or DATA_DIR
  const inSessions = filePath.startsWith(BASE_SESSIONS_DIR);
  const inData = filePath.startsWith(DATA_DIR);

  if ((!inSessions && !inData) || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return NextResponse.json({ error: "Path is a directory" }, { status: 400 });
  }

  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();

  let contentType = "application/octet-stream";
  if (ext === ".mp4") contentType = "video/mp4";
  else if (ext === ".mov") contentType = "video/quicktime";
  else if (ext === ".webm") contentType = "video/webm";
  else if (ext === ".mp3") contentType = "audio/mpeg";
  else if (ext === ".wav") contentType = "audio/wav";
  else if (ext === ".m4a") contentType = "audio/mp4";
  else if (ext === ".zip") contentType = "application/zip";

  const isZip = ext === ".zip";
  const downloadHeaders: Record<string, string> = isZip
    ? {
        "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
      }
    : {};

  const range = req.headers.get("range");
  if (range && !isZip) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const fileBuffer = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, fileBuffer, 0, chunkSize, start);
    fs.closeSync(fd);

    return new NextResponse(fileBuffer, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": contentType,
      },
    });
  }

  const fileBuffer = fs.readFileSync(filePath);
  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
      ...downloadHeaders,
    },
  });
}
