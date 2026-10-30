import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OUTPUTS_DIR } from "@/lib/store";
import { ZvidRenderPayload } from "@/types/lachvid";

export const ZVID_BASE_URL = "https://api.zvid.io";

export function resolveZvidApiKey(overrideKey?: string): string {
  const key = (overrideKey || process.env.ZVID_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Thiếu ZVID_API_KEY. Vui lòng nhập API Key trên giao diện hoặc cấu hình biến môi trường ZVID_API_KEY."
    );
  }
  return key;
}

/**
 * 1. Fetch dynamic plan limits and live render schema from Zvid
 * GET /api/render/schema/api-key
 */
export async function fetchZvidSchemaAndLimits(apiKey?: string) {
  const key = resolveZvidApiKey(apiKey);
  const res = await fetch(`${ZVID_BASE_URL}/api/render/schema/api-key`, {
    method: "GET",
    headers: {
      "x-api-key": key,
    },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || `Zvid Schema HTTP ${res.status}`);
  }
  return data as {
    schemaVersion: string;
    planLimits: Record<string, unknown>;
    target: string;
    validationNotes?: string[];
  };
}

/**
 * 2. List existing uploaded assets & quota usage
 * GET /api/uploads
 */
export async function listZvidUploads(apiKey?: string) {
  const key = resolveZvidApiKey(apiKey);
  const res = await fetch(`${ZVID_BASE_URL}/api/uploads`, {
    method: "GET",
    headers: {
      "x-api-key": key,
    },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || `Zvid Uploads HTTP ${res.status}`);
  }
  return data as {
    uploads: {
      id: string;
      kind: "image" | "video" | "audio" | "gif";
      fileName: string;
      sizeBytes: number;
      url: string;
      duration?: number | null;
    }[];
    usage: {
      files: number;
      usedBytes: number;
      maxTotalBytes: number;
    };
  };
}

/**
 * 3. Upload a local media file to Zvid via multipart/form-data (`file` field)
 * POST /api/uploads
 */
export async function uploadFileToZvid(params: {
  localPath: string;
  fileName: string;
  mimeType: string;
  apiKey?: string;
}) {
  const key = resolveZvidApiKey(params.apiKey);
  if (!fs.existsSync(params.localPath)) {
    throw new Error(`Không tìm thấy file local: ${params.localPath}`);
  }

  const buffer = fs.readFileSync(params.localPath);
  const blob = new Blob([buffer], { type: params.mimeType });
  const formData = new FormData();
  formData.append("file", blob, params.fileName);

  const res = await fetch(`${ZVID_BASE_URL}/api/uploads`, {
    method: "POST",
    headers: {
      "x-api-key": key,
    },
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Upload lên Zvid thất bại (HTTP ${res.status})`
    );
  }

  return data.upload as {
    id: string;
    kind: "image" | "video" | "audio" | "gif";
    fileName: string;
    sizeBytes: number;
    url: string;
    duration?: number | null;
    width?: number | null;
    height?: number | null;
    createdAt?: string;
  };
}

/**
 * 4. Free Pre-flight Validation & Credit Estimation
 * POST /api/render/validate/api-key
 */
export async function validateZvidRender(params: {
  payload: ZvidRenderPayload;
  jobId?: string;
  apiKey?: string;
}) {
  const key = resolveZvidApiKey(params.apiKey);
  const body: Record<string, unknown> = {
    payload: params.payload,
  };
  if (params.jobId) {
    body.jobId = params.jobId;
  }

  const res = await fetch(`${ZVID_BASE_URL}/api/render/validate/api-key`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    return {
      valid: false,
      creditsRequired: Math.ceil(params.payload.duration),
      warnings: [],
      error: data.message || data.error || `Validation failed (${res.status})`,
      details: data.details || [],
      planLimits: data.planLimits || null,
    };
  }

  return {
    valid: Boolean(data.valid),
    creditsRequired: Number(data.creditsRequired ?? Math.ceil(params.payload.duration)),
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    schemaVersion: data.schemaVersion,
  };
}

/**
 * 5. Submit Asynchronous Video Render Job with Retry-After handling and JobId tracking
 * POST /api/render/api-key
 */
export async function submitZvidRenderJob(params: {
  payload: ZvidRenderPayload;
  jobId: string;
  webhookUrl?: string;
  apiKey?: string;
}): Promise<{
  jobId: string;
  status: string;
  queuePosition: number;
  creditsReserved: number;
}> {
  const key = resolveZvidApiKey(params.apiKey);
  const body: Record<string, unknown> = {
    payload: params.payload,
    jobId: params.jobId,
  };
  if (params.webhookUrl) {
    body.webhookUrl = params.webhookUrl;
  }

  const res = await fetch(`${ZVID_BASE_URL}/api/render/api-key`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const retryHeader = res.headers.get("retry-after");
    const data = await res.json().catch(() => ({}));
    const waitSeconds =
      Number(retryHeader || data.retryAfter || 5) || 5;
    throw new Error(
      `HTTP 429: Chạm giới hạn hàng đợi của gói Zvid. Vui lòng đợi ${waitSeconds}s (Retry-After) rồi thử lại.`
    );
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Submit render thất bại (HTTP ${res.status})`
    );
  }

  return {
    jobId: data.jobId || params.jobId,
    status: data.status || "queued",
    queuePosition: Number(data.queuePosition ?? 1),
    creditsReserved: Number(data.creditsReserved ?? Math.ceil(params.payload.duration)),
  };
}

/**
 * 6. Poll Render Job Status and Auto-Persist Completed Output Locally
 * GET /api/jobs/{id}
 */
export async function getZvidJobStatusAndPersist(params: {
  jobId: string;
  apiKey?: string;
}) {
  const key = resolveZvidApiKey(params.apiKey);
  const res = await fetch(`${ZVID_BASE_URL}/api/jobs/${params.jobId}`, {
    method: "GET",
    headers: {
      "x-api-key": key,
    },
    cache: "no-store",
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Không kiểm tra được job ${params.jobId}`
    );
  }

  // Handle both result shapes documented in Zvid API: string OR { url: string }
  let remoteUrl: string | null = null;
  if (typeof data.result === "string") {
    remoteUrl = data.result;
  } else if (data.result && typeof data.result === "object" && data.result.url) {
    remoteUrl = data.result.url;
  }

  let progressNum = 0;
  if (typeof data.progress === "number") {
    progressNum = data.progress;
  } else if (
    data.progress &&
    typeof data.progress === "object" &&
    typeof data.progress.percentage === "number"
  ) {
    progressNum = data.progress.percentage;
  } else if (data.state === "completed") {
    progressNum = 100;
  }

  let localOutputUrl: string | null = null;
  if (data.state === "completed" && remoteUrl) {
    localOutputUrl = await persistRemoteVideoLocally(params.jobId, remoteUrl);
  }

  return {
    id: data.id as string,
    state: data.state as string,
    progress: progressNum,
    remoteResultUrl: remoteUrl,
    localOutputUrl,
    failedReason: (data.failedReason as string | null) || null,
    outputExpiresAt: (data.outputExpiresAt as string | null) || null,
  };
}

/**
 * Downloads a completed Zvid CDN video to `/data/outputs/{jobId}.mp4`
 * so the user never loses outputs when Zvid CDN URLs expire (7d Free / 30d Hobby).
 */
export async function persistRemoteVideoLocally(
  jobId: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(OUTPUTS_DIR)) {
      fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
    }
    const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
    const fileName = `${safeId}.mp4`;
    const filePath = path.join(OUTPUTS_DIR, fileName);

    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
      return `/api/media/outputs/${fileName}`;
    }

    const res = await fetch(remoteUrl);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    return `/api/media/outputs/${fileName}`;
  } catch {
    return null;
  }
}

/**
 * Verifies Zvid Registered Webhook HMAC-SHA256 signature over `<timestamp>.<rawBody>`
 */
export function verifyZvidWebhookSignature(params: {
  rawBody: Buffer;
  timestampHeader: string;
  signatureHeader: string;
  secret: string;
}): boolean {
  const { rawBody, timestampHeader, signatureHeader, secret } = params;
  if (!/^\d+$/.test(timestampHeader)) return false;
  const seconds = Number(timestampHeader);
  if (!Number.isSafeInteger(seconds)) return false;
  if (Math.abs(Date.now() / 1000 - seconds) > 300) return false; // 5-minute replay window
  if (!/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestampHeader + ".")
    .update(rawBody)
    .digest();
  const received = Buffer.from(signatureHeader.slice(7), "hex");
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(received, expected);
}
