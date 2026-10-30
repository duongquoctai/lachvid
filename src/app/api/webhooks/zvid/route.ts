import { NextRequest, NextResponse } from "next/server";
import { readProjectState, writeProjectState } from "@/lib/store";
import {
  persistRemoteVideoLocally,
  verifyZvidWebhookSignature,
} from "@/lib/zvid";

const processedDeliveries = new Set<string>();

export async function POST(req: NextRequest) {
  const secret = process.env.ZVID_WEBHOOK_SECRET || "";
  const timestamp = req.headers.get("x-zvid-timestamp") || "";
  const signature = req.headers.get("x-zvid-signature") || "";
  const deliveryId = req.headers.get("x-zvid-delivery-id") || "";

  const arrayBuffer = await req.arrayBuffer();
  const rawBody = Buffer.from(arrayBuffer);

  if (secret) {
    const valid = verifyZvidWebhookSignature({
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      secret,
    });
    if (!valid) {
      return new NextResponse("Invalid webhook signature", { status: 401 });
    }
  }

  if (deliveryId && processedDeliveries.has(deliveryId)) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    const event = JSON.parse(rawBody.toString("utf8"));
    if (event.test === true) {
      return new NextResponse(null, { status: 204 });
    }

    const jobId = event.jobId || req.headers.get("x-zvid-job-id");
    if (!jobId) {
      return new NextResponse(null, { status: 204 });
    }

    const state = readProjectState();
    const target = state.composedVideos.find((v) => v.jobId === jobId);

    if (target) {
      if (event.event === "render.completed" && event.data?.url) {
        target.renderState = "completed";
        target.progress = 100;
        target.remoteResultUrl = event.data.url;
        const localUrl = await persistRemoteVideoLocally(jobId, event.data.url);
        if (localUrl) {
          target.localOutputUrl = localUrl;
        }
        target.updatedAt = new Date().toISOString();
        writeProjectState(state);
      } else if (event.event === "render.failed") {
        target.renderState = "failed";
        target.failedReason =
          event.data?.error || "Render failed via Zvid webhook";
        target.updatedAt = new Date().toISOString();
        writeProjectState(state);
      }
    }

    if (deliveryId) {
      processedDeliveries.add(deliveryId);
    }

    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse("Bad JSON", { status: 400 });
  }
}
