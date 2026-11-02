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
  totalExtracted: number;
  skippedRows: number;
}

/**
 * Parses multi-row, 5-column clipboard text copied directly from Excel.
 * In Excel copy-paste, columns are separated by \t and rows by \n.
 */
export function parseExcelFiveColumnClipboard(text: string): ParsedFiveColumnLinks {
  const result: ParsedFiveColumnLinks = {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
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

    // Distribute up to 5 columns
    for (let colIdx = 0; colIdx < Math.min(cells.length, 5); colIdx++) {
      const cellContent = cells[colIdx];
      if (!cellContent) continue;

      const fileId = extractGoogleDriveFileId(cellContent);
      if (fileId) {
        const cat = CATEGORY_COLUMNS[colIdx];
        if (cat) {
          result[cat].push(fileId);
          result.totalExtracted++;
        }
      }
    }
  }

  return result;
}

/**
 * Helper to parse MP4 Duration from mvhd atom in buffer
 */
export function parseMp4DurationFromBuffer(buffer: Buffer): number | null {
  try {
    let offset = 0;
    const len = buffer.length;

    while (offset + 8 <= len) {
      const boxSize = buffer.readUInt32BE(offset);
      const boxType = buffer.toString("latin1", offset + 4, offset + 8);

      if (boxSize === 0) break; // Until EOF
      const actualSize = boxSize === 1 ? Number(buffer.readBigUInt64BE(offset + 8)) : boxSize;
      if (actualSize <= 0 || isNaN(actualSize)) break;

      if (boxType === "moov") {
        // Search inside moov for mvhd
        let moovOffset = offset + (boxSize === 1 ? 16 : 8);
        const moovEnd = Math.min(len, offset + actualSize);

        while (moovOffset + 8 <= moovEnd) {
          const subSize = buffer.readUInt32BE(moovOffset);
          const subType = buffer.toString("latin1", moovOffset + 4, moovOffset + 8);

          if (subSize <= 0) break;

          if (subType === "mvhd") {
            const mvhdDataOffset = moovOffset + 8;
            if (mvhdDataOffset + 24 <= len) {
              const version = buffer.readUInt8(mvhdDataOffset);
              if (version === 0) {
                // version 0: 1 byte ver + 3 bytes flags + 4 bytes ctime + 4 bytes mtime + 4 bytes timescale + 4 bytes duration
                const timescale = buffer.readUInt32BE(mvhdDataOffset + 12);
                const durationUnits = buffer.readUInt32BE(mvhdDataOffset + 16);
                if (timescale > 0) {
                  return Math.round((durationUnits / timescale) * 100) / 100;
                }
              } else if (version === 1) {
                // version 1: 1 byte ver + 3 bytes flags + 8 bytes ctime + 8 bytes mtime + 4 bytes timescale + 8 bytes duration
                const timescale = buffer.readUInt32BE(mvhdDataOffset + 20);
                const durationUnits = Number(buffer.readBigUInt64BE(mvhdDataOffset + 24));
                if (timescale > 0) {
                  return Math.round((durationUnits / timescale) * 100) / 100;
                }
              }
            }
            break;
          }

          moovOffset += subSize;
        }
        break;
      }

      offset += actualSize;
    }
  } catch {
    // If parsing fails, ignore and return null
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
  error?: string;
}

/**
 * Probes Google Drive clip metadata in RAM by reading only first 128KB.
 * 0 MB disk used.
 */
export async function probeGoogleDriveClipMetadata(
  fileId: string
): Promise<DriveClipProbeResult> {
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(directUrl, {
      method: "GET",
      headers: {
        Range: "bytes=0-131071", // Read first 128 KB
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
    // If Google returned HTML, it means the file is private or requires Google login
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

    // Extract filename from Content-Disposition header
    let fileName = `drive_${fileId.slice(0, 8)}.mp4`;
    const cd = res.headers.get("content-disposition") || "";
    const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i);
    if (fnMatch && fnMatch[1]) {
      fileName = decodeURIComponent(fnMatch[1].trim()).replace(/\+/g, " ");
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract exact duration from MP4 faststart mvhd atom
    let duration = parseMp4DurationFromBuffer(buffer) || 4.0;
    if (duration <= 0.1 || duration > 3600) {
      duration = 4.0;
    }

    // Total file size from Content-Range or Content-Length
    let totalSizeBytes = buffer.length;
    const contentRange = res.headers.get("content-range") || "";
    const crMatch = contentRange.match(/\/(\d+)$/);
    if (crMatch && crMatch[1]) {
      totalSizeBytes = parseInt(crMatch[1], 10);
    } else {
      const cl = res.headers.get("content-length");
      if (cl) totalSizeBytes = parseInt(cl, 10);
    }

    const lowerName = fileName.toLowerCase();
    const lockFlipH = lowerName.includes("_lock");

    return {
      success: true,
      fileId,
      fileName,
      duration,
      sizeBytes: totalSizeBytes,
      lockFlipH,
    };
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
