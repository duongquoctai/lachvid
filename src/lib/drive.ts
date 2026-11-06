import crypto from "node:crypto";
import { ShotCategory } from "@/types/lachvid";

/**
 * Extracts Google Drive File ID from various URL patterns:
 * - https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/view?usp=sharing
 * - https://drive.google.com/open?id=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
 * - https://drive.google.com/uc?id=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
 * - https://drive.google.com/uc?export=download&id=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
 * - https://drive.usercontent.google.com/download?id=1aBcDeFgHiJkLmNoPqRsTuVwXyZ
 * - Or raw File ID itself
 */
export function extractGoogleDriveFileId(rawInput: string): string | null {
  if (!rawInput) return null;
  const input = rawInput.trim();
  if (!input) return null;

  // Pattern /file/d/ID
  const matchPath = input.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (matchPath && matchPath[1]) return matchPath[1];

  // Pattern id=ID
  const matchParam = input.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (matchParam && matchParam[1]) return matchParam[1];

  // Pattern /d/ID
  const matchShort = input.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (matchShort && matchShort[1]) return matchShort[1];

  // If input itself is an ID
  if (/^[a-zA-Z0-9_-]{25,50}$/.test(input)) {
    return input;
  }

  return null;
}

export const CATEGORY_COLUMNS: ShotCategory[] = [
  "open",
  "product",
  "texture",
  "apply",
  "end",
];

export interface ParsedFiveColumnLinks {
  open: string[];
  product: string[];
  texture: string[];
  apply: string[];
  end: string[];
  voice?: string[];
  totalExtracted: number;
  skippedRows: number;
}

/**
 * Parses multi-row, up to 6-column clipboard text copied directly from Excel.
 * In Excel copy-paste, columns are separated by \t and rows by \n.
 * Column 1..5: open, product, texture, apply, end. Column 6: voice.
 */
export function parseExcelFiveColumnClipboard(text: string): ParsedFiveColumnLinks {
  const result: ParsedFiveColumnLinks = {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
    voice: [],
    totalExtracted: 0,
    skippedRows: 0,
  };

  if (!text || typeof text !== "string") return result;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return result;

  const headerKeywords = [
    "open",
    "product",
    "texture",
    "apply",
    "end",
    "hook",
    "cta",
    "sản phẩm",
    "cảnh",
    "nhóm",
    "category",
    "voice",
    "lồng tiếng",
    "audio",
    "thoại",
    "mp3",
  ];

  const columnKeys: Array<ShotCategory | "voice"> = [
    "open",
    "product",
    "texture",
    "apply",
    "end",
    "voice",
  ];

  for (let rowIdx = 0; rowIdx < lines.length; rowIdx++) {
    const line = lines[rowIdx];
    // Split by tab (Excel column delimiter)
    const cells = line.split("\t").map((c) => c.trim());

    // Check if this row is a header row
    if (rowIdx === 0) {
      const isHeader = cells.some((cell) => {
        const lower = cell.toLowerCase();
        return headerKeywords.some((kw) => lower.includes(kw));
      });
      if (isHeader) {
        result.skippedRows++;
        continue;
      }
    }

    // Distribute up to 6 columns
    for (let colIdx = 0; colIdx < Math.min(cells.length, 6); colIdx++) {
      const cellContent = cells[colIdx];
      if (!cellContent) continue;

      const fileId = extractGoogleDriveFileId(cellContent);
      if (fileId) {
        const key = columnKeys[colIdx];
        if (key === "voice") {
          result.voice?.push(fileId);
          result.totalExtracted++;
        } else if (key) {
          result[key].push(fileId);
          result.totalExtracted++;
        }
      }
    }
  }

  return result;
}

/**
 * Helper to parse MP4/MOV Duration from mvhd atom in buffer
 */
export function parseMp4DurationFromBuffer(buffer: Buffer): number | null {
  try {
    const mvhdIdx = buffer.indexOf("mvhd");
    if (mvhdIdx !== -1 && mvhdIdx + 28 <= buffer.length) {
      const mvhdDataOffset = mvhdIdx + 4;
      const version = buffer.readUInt8(mvhdDataOffset);
      if (version === 0 && mvhdDataOffset + 20 <= buffer.length) {
        const timescale = buffer.readUInt32BE(mvhdDataOffset + 12);
        const durationUnits = buffer.readUInt32BE(mvhdDataOffset + 16);
        if (timescale > 0) {
          return Math.round((durationUnits / timescale) * 100) / 100;
        }
      } else if (version === 1 && mvhdDataOffset + 32 <= buffer.length) {
        const timescale = buffer.readUInt32BE(mvhdDataOffset + 20);
        const durationUnits = Number(buffer.readBigUInt64BE(mvhdDataOffset + 24));
        if (timescale > 0) {
          return Math.round((durationUnits / timescale) * 100) / 100;
        }
      }
    }
  } catch {
    // If parsing fails, ignore and return null
  }
  return null;
}

/**
 * Helper to estimate MP3 duration from MPEG frame header bitrate & file size
 */
export function parseMp3DurationFromBuffer(buffer: Buffer, totalSizeBytes: number): number | null {
  try {
    if (totalSizeBytes <= 0 || buffer.length < 16) return null;
    let offset = 0;

    // Skip ID3v2 tag if present at start
    if (
      buffer.length >= 10 &&
      buffer[0] === 0x49 && // 'I'
      buffer[1] === 0x44 && // 'D'
      buffer[2] === 0x33    // '3'
    ) {
      const id3Size =
        ((buffer[6] & 0x7f) << 21) |
        ((buffer[7] & 0x7f) << 14) |
        ((buffer[8] & 0x7f) << 7) |
        (buffer[9] & 0x7f);
      offset = 10 + id3Size;
    }

    const bitratesV1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const bitratesV2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

    for (let i = Math.max(0, offset); i < buffer.length - 4; i++) {
      if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
        const versionBits = (buffer[i + 1] >> 3) & 0x03;
        const layerBits = (buffer[i + 1] >> 1) & 0x03;
        const bitrateIdx = (buffer[i + 2] >> 4) & 0x0f;
        const sampleRateIdx = (buffer[i + 2] >> 2) & 0x03;
        if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) {
          continue;
        }
        const kbps = versionBits === 3 ? bitratesV1L3[bitrateIdx] : bitratesV2L3[bitrateIdx];
        if (kbps > 0) {
          const audioBytes = Math.max(0, totalSizeBytes - offset);
          const sec = (audioBytes * 8) / (kbps * 1000);
          if (sec > 0.3 && sec < 7200) {
            return Math.round(sec * 10) / 10;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export interface DriveClipProbeResult {
  success: boolean;
  fileId: string;
  fileName: string;
  duration: number;
  sizeBytes: number;
  lockFlipH: boolean;
  contentHash?: string;
  error?: string;
}

// In-memory cache to avoid re-probing identical Google Drive fileIds
const clipProbeCache = new Map<string, DriveClipProbeResult>();
const voiceProbeCache = new Map<string, DriveVoiceProbeResult>();

/**
 * Probes Google Drive clip metadata in RAM.
 * Checks head (128KB) or tail (128KB) for mvhd atom to extract exact duration.
 * 0 MB disk used.
 */
export async function probeGoogleDriveClipMetadata(
  fileId: string
): Promise<DriveClipProbeResult> {
  const cached = clipProbeCache.get(fileId);
  if (cached) return cached;

  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(directUrl, {
      method: "GET",
      headers: {
        Range: "bytes=0-65535", // Read first 64 KB (faststart mvhd is in first few KB)
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok && res.status !== 206) {
      return {
        success: false,
        fileId,
        fileName: `drive_${fileId.slice(0, 8)}.mp4`,
        duration: 4.0,
        sizeBytes: 0,
        lockFlipH: false,
        error: `HTTP ${res.status}: Không thể truy cập file Google Drive`,
      };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      return {
        success: false,
        fileId,
        fileName: `drive_${fileId.slice(0, 8)}.mp4`,
        duration: 4.0,
        sizeBytes: 0,
        lockFlipH: false,
        error: "Link chưa mở quyền công khai (Anyone with the link can view)",
      };
    }

    let fileName = `drive_${fileId.slice(0, 8)}.mp4`;
    const cd = res.headers.get("content-disposition") || "";
    const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i);
    if (fnMatch && fnMatch[1]) {
      fileName = decodeURIComponent(fnMatch[1].trim()).replace(/\+/g, " ");
    }

    const arrayBuffer = await res.arrayBuffer();
    const headBuffer = Buffer.from(arrayBuffer);

    // Total file size from Content-Range or Content-Length
    let totalSizeBytes = headBuffer.length;
    const contentRange = res.headers.get("content-range") || "";
    const crMatch = contentRange.match(/\/(\d+)$/);
    if (crMatch && crMatch[1]) {
      totalSizeBytes = parseInt(crMatch[1], 10);
    } else {
      const cl = res.headers.get("content-length");
      if (cl) totalSizeBytes = parseInt(cl, 10);
    }

    // Try extracting duration from head buffer
    let duration = parseMp4DurationFromBuffer(headBuffer);

    // If moov/mvhd is at the end of the file (common in QuickTime MOV/iPhone videos), fetch the last 128 KB
    if (!duration && totalSizeBytes > 131072) {
      try {
        const tailStart = Math.max(0, totalSizeBytes - 131072);
        const tailRes = await fetch(directUrl, {
          method: "GET",
          headers: {
            Range: `bytes=${tailStart}-${totalSizeBytes - 1}`,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          redirect: "follow",
        });
        if (tailRes.ok || tailRes.status === 206) {
          const tailBuf = Buffer.from(await tailRes.arrayBuffer());
          duration = parseMp4DurationFromBuffer(tailBuf);
        }
      } catch {
        // ignore tail probe failure
      }
    }

    if (!duration || duration <= 0.1 || duration > 3600) {
      duration = 4.0;
    }

    const lowerName = fileName.toLowerCase();
    const lockFlipH = lowerName.includes("_lock");

    const contentHash = crypto
      .createHash("md5")
      .update(headBuffer)
      .update(String(totalSizeBytes))
      .digest("hex")
      .slice(0, 16);

    const result: DriveClipProbeResult = {
      success: true,
      fileId,
      fileName,
      duration,
      sizeBytes: totalSizeBytes,
      lockFlipH,
      contentHash,
    };
    clipProbeCache.set(fileId, result);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      fileId,
      fileName: `drive_${fileId.slice(0, 8)}.mp4`,
      duration: 4.0,
      sizeBytes: 0,
      lockFlipH: false,
      error: `Lỗi kết nối tới Google Drive: ${msg}`,
    };
  }
}

export interface DriveVoiceProbeResult {
  success: boolean;
  fileId: string;
  name: string;
  fileName: string;
  duration: number;
  sizeBytes: number;
  error?: string;
}

/**
 * Probes Google Drive voice/audio metadata in RAM using a single 32KB range request. 0 MB disk used.
 */
export async function probeGoogleDriveVoiceMetadata(
  fileId: string,
  indexFallback: number = 1
): Promise<DriveVoiceProbeResult> {
  const cached = voiceProbeCache.get(fileId);
  if (cached) return cached;

  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(directUrl, {
      method: "GET",
      headers: {
        Range: "bytes=0-32767", // Read first 32 KB only
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok && res.status !== 206) {
      return {
        success: false,
        fileId,
        name: `Voice ${indexFallback}`,
        fileName: `voice_${fileId.slice(0, 8)}.mp3`,
        duration: 20.0,
        sizeBytes: 0,
        error: `HTTP ${res.status}: Không thể truy cập file Google Drive`,
      };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      return {
        success: false,
        fileId,
        name: `Voice ${indexFallback}`,
        fileName: `voice_${fileId.slice(0, 8)}.mp3`,
        duration: 20.0,
        sizeBytes: 0,
        error: "Link chưa mở quyền công khai (Anyone with the link can view)",
      };
    }

    let fileName = `voice_${fileId.slice(0, 8)}.mp3`;
    const cd = res.headers.get("content-disposition") || "";
    const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i);
    if (fnMatch && fnMatch[1]) {
      fileName = decodeURIComponent(fnMatch[1].trim()).replace(/\+/g, " ");
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let totalSizeBytes = buffer.length;
    const contentRange = res.headers.get("content-range") || "";
    const crMatch = contentRange.match(/\/(\d+)$/);
    if (crMatch && crMatch[1]) {
      totalSizeBytes = parseInt(crMatch[1], 10);
    } else {
      const cl = res.headers.get("content-length");
      if (cl) totalSizeBytes = parseInt(cl, 10);
    }

    // Parse MP3 frame header bitrate duration or MP4/M4A mvhd duration in 1 pass
    let duration =
      parseMp3DurationFromBuffer(buffer, totalSizeBytes) ||
      parseMp4DurationFromBuffer(buffer) ||
      0;

    if (!duration || duration <= 0.1 || duration > 7200) {
      duration = 20.0;
    }

    const ext = fileName.includes(".") ? fileName.substring(fileName.lastIndexOf(".")) : "";
    const name = ext ? fileName.slice(0, -ext.length) : fileName;

    const result: DriveVoiceProbeResult = {
      success: true,
      fileId,
      name,
      fileName,
      duration,
      sizeBytes: totalSizeBytes,
    };
    voiceProbeCache.set(fileId, result);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      fileId,
      name: `Voice ${indexFallback}`,
      fileName: `voice_${fileId.slice(0, 8)}.mp3`,
      duration: 20.0,
      sizeBytes: 0,
      error: `Lỗi kết nối tới Google Drive: ${msg}`,
    };
  }
}
