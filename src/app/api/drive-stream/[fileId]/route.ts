import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  if (!fileId || typeof fileId !== "string") {
    return NextResponse.json({ error: "Thiếu fileId" }, { status: 400 });
  }

  const directUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
    fileId
  )}`;

  const forwardHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  const clientRange = req.headers.get("range");
  if (clientRange) {
    forwardHeaders["Range"] = clientRange;
  }

  try {
    const driveRes = await fetch(directUrl, {
      method: "GET",
      headers: forwardHeaders,
      redirect: "follow",
    });

    if (!driveRes.ok && driveRes.status !== 206) {
      return NextResponse.json(
        { error: `Google Drive trả mã lỗi HTTP ${driveRes.status}` },
        { status: driveRes.status }
      );
    }

    const contentType = driveRes.headers.get("content-type") || "video/mp4";
    if (contentType.toLowerCase().includes("text/html")) {
      return NextResponse.json(
        { error: "File chưa mở quyền chia sẻ công khai trên Google Drive" },
        { status: 403 }
      );
    }

    const resHeaders = new Headers();
    resHeaders.set("Content-Type", contentType);
    resHeaders.set("Accept-Ranges", "bytes");

    const contentLength = driveRes.headers.get("content-length");
    if (contentLength) {
      resHeaders.set("Content-Length", contentLength);
    }

    const contentRange = driveRes.headers.get("content-range");
    if (contentRange) {
      resHeaders.set("Content-Range", contentRange);
    }

    const contentDisposition = driveRes.headers.get("content-disposition");
    if (contentDisposition) {
      resHeaders.set("Content-Disposition", contentDisposition);
    }

    return new Response(driveRes.body, {
      status: driveRes.status,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Lỗi streaming từ Google Drive: ${msg}` },
      { status: 502 }
    );
  }
}
