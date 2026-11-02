import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  cleanupExpiredSessions,
  clearSessionCategories,
  ensureSessionDirs,
  getSessionIdFromHeaders,
  readProjectState,
  sanitizeSessionId,
  writeProjectState,
} from "@/lib/store";
import { CategoryPools, CategoryVideoItem, MultiVoiceItem, ShotCategory } from "@/types/lachvid";
import { extractGoogleDriveFileId, probeGoogleDriveClipMetadata } from "@/lib/drive";

const VALID_CATS: ShotCategory[] = ["open", "product", "texture", "apply", "end"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qSessionId = url.searchParams.get("sessionId");
  const sessionId = sanitizeSessionId(qSessionId || getSessionIdFromHeaders(req.headers));

  ensureSessionDirs(sessionId);
  const state = readProjectState(sessionId);

  const pools: CategoryPools = state.categoryPools || {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  };

  return NextResponse.json({
    sessionId,
    categoryPools: pools,
    multiVoiceTracks: state.multiVoiceTracks || [],
  });
}

// Helper to run promises in parallel with concurrency limit
async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = 6
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const curIdx = index++;
      results[curIdx] = await fn(items[curIdx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function POST(req: NextRequest) {
  cleanupExpiredSessions();

  const contentType = req.headers.get("content-type") || "";
  let action = "upload";
  let sessionId = "";
  let jsonData: Record<string, unknown> | null = null;
  let formData: FormData | null = null;

  if (contentType.includes("application/json")) {
    jsonData = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    action = (jsonData?.action as string) || "ingest_drive_links";
    sessionId = sanitizeSessionId(
      (jsonData?.sessionId as string) || getSessionIdFromHeaders(req.headers)
    );
  } else {
    formData = await req.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
    }
    action = (formData.get("action") as string) || "upload";
    sessionId = sanitizeSessionId(
      (formData.get("sessionId") as string) || getSessionIdFromHeaders(req.headers)
    );
  }

  const sessionPaths = ensureSessionDirs(sessionId);
  const state = readProjectState(sessionId);

  const pools: CategoryPools = state.categoryPools || {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  };

  // Ingest Google Drive links (0 MB Disk)
  if (action === "ingest_drive_links") {
    let categoryLinksMap: Partial<Record<ShotCategory, string[]>> = {};

    if (jsonData?.categoryLinks && typeof jsonData.categoryLinks === "object") {
      categoryLinksMap = jsonData.categoryLinks as Partial<Record<ShotCategory, string[]>>;
    } else if (jsonData?.targetCategory && Array.isArray(jsonData?.links)) {
      const cat = jsonData.targetCategory as ShotCategory;
      if (VALID_CATS.includes(cat)) {
        categoryLinksMap[cat] = jsonData.links as string[];
      }
    } else if (formData) {
      const targetCat = (formData.get("targetCategory") as ShotCategory) || "product";
      const rawLinks = (formData.get("links") as string) || "";
      if (VALID_CATS.includes(targetCat)) {
        categoryLinksMap[targetCat] = rawLinks
          .split(/[\r\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const tasks: { category: ShotCategory; fileId: string }[] = [];
    let duplicateCount = 0;

    for (const cat of VALID_CATS) {
      const links = categoryLinksMap[cat] || [];
      const currentCatPool = pools[cat] || [];

      for (const raw of links) {
        const fileId = extractGoogleDriveFileId(raw);
        if (!fileId) continue;

        // Check if already in pool
        const alreadyExists = currentCatPool.some(
          (it) => it.driveFileId === fileId || it.id.includes(fileId.slice(0, 10))
        );
        if (alreadyExists) {
          duplicateCount++;
          continue;
        }

        // Avoid adding multiple times in the same incoming payload
        if (tasks.some((t) => t.category === cat && t.fileId === fileId)) {
          duplicateCount++;
          continue;
        }

        tasks.push({ category: cat, fileId });
      }
    }

    if (tasks.length === 0) {
      return NextResponse.json({
        success: true,
        sessionId,
        addedCount: 0,
        duplicateCount,
        errors: [],
        categoryPools: pools,
        message: duplicateCount > 0 ? "Toàn bộ link đã có sẵn trong kho." : "Không có link hợp lệ.",
      });
    }

    // Probe metadata concurrently in RAM (up to 6 parallel)
    const probeResults = await pMap(
      tasks,
      async (task) => {
        const probe = await probeGoogleDriveClipMetadata(task.fileId);
        return {
          category: task.category,
          probe,
        };
      },
      6
    );

    const addedItems: CategoryVideoItem[] = [];
    const errors: { fileId: string; category: string; error: string }[] = [];

    for (const res of probeResults) {
      const { category, probe } = res;
      if (!probe.success) {
        errors.push({
          fileId: probe.fileId,
          category,
          error: probe.error || "Không thể tải metadata từ Google Drive",
        });
        continue;
      }

      const safeBase = probe.fileName.replace(/\.[^/.]+$/, "");
      const item: CategoryVideoItem = {
        id: `drive_${category}_${probe.fileId.slice(0, 10)}_${Date.now().toString(36)}`,
        name: safeBase,
        fileName: probe.fileName,
        category,
        localUrl: `/api/drive-stream/${probe.fileId}`,
        // localPath is deliberately undefined: 0 MB disk used
        duration: probe.duration || 4.0,
        sizeBytes: probe.sizeBytes,
        lockFlipH: probe.lockFlipH,
        driveFileId: probe.fileId,
        sourceType: "drive",
      };

      pools[category].push(item);
      addedItems.push(item);
    }

    state.categoryPools = pools;
    writeProjectState(state, sessionId);

    return NextResponse.json({
      success: true,
      sessionId,
      addedCount: addedItems.length,
      duplicateCount,
      errors,
      categoryPools: pools,
    });
  }

  // Clear single category
  if (action === "clear_category") {
    const category = ((formData?.get("category") || jsonData?.category) as ShotCategory) || "open";
    if (pools[category]) {
      // Delete any physical files if local
      const catDir = path.join(sessionPaths.categoriesDir, category);
      if (fs.existsSync(catDir)) {
        fs.rmSync(catDir, { recursive: true, force: true });
        fs.mkdirSync(catDir, { recursive: true });
      }
      pools[category] = [];
    }
    state.categoryPools = pools;
    writeProjectState(state, sessionId);
    return NextResponse.json({ success: true, sessionId, categoryPools: pools });
  }

  // Clear all categories
  if (action === "clear_all") {
    clearSessionCategories(sessionId);
    pools.open = [];
    pools.product = [];
    pools.texture = [];
    pools.apply = [];
    pools.end = [];
    state.categoryPools = pools;
    state.multiVoiceTracks = [];
    writeProjectState(state, sessionId);
    return NextResponse.json({
      success: true,
      sessionId,
      categoryPools: pools,
      multiVoiceTracks: [],
    });
  }

  // Remove single item
  if (action === "remove_item") {
    const itemId = (formData?.get("itemId") || jsonData?.itemId) as string;
    const category = ((formData?.get("category") || jsonData?.category) as ShotCategory) || "product";
    if (category && pools[category]) {
      const targetItem = pools[category].find((i) => i.id === itemId);
      if (targetItem?.localPath && fs.existsSync(targetItem.localPath)) {
        try {
          fs.unlinkSync(targetItem.localPath);
        } catch {
          // Ignore
        }
      }
      pools[category] = pools[category].filter((i) => i.id !== itemId);
    }
    state.categoryPools = pools;
    writeProjectState(state, sessionId);
    return NextResponse.json({ success: true, sessionId, categoryPools: pools });
  }

  // Voice track upload
  if (action === "upload_voice" && formData) {
    const files = formData.getAll("files") as File[];
    const newVoices: MultiVoiceItem[] = state.multiVoiceTracks || [];

    for (const file of files) {
      if (!file || typeof file === "string" || !file.name) continue;
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const safeName = path.basename(file.name).replace(/\s+/g, "_");
      const ext = path.extname(safeName).toLowerCase() || ".mp3";
      const id = `voice_${crypto.randomBytes(4).toString("hex")}`;
      const savedFileName = `${id}_${safeName}`;
      const filePath = path.join(sessionPaths.voicesDir, savedFileName);

      fs.writeFileSync(filePath, buffer);

      newVoices.push({
        id,
        name: safeName.replace(ext, ""),
        fileName: savedFileName,
        localUrl: `/api/media/sessions/${sessionId}/voices/${savedFileName}`,
        localPath: filePath,
        duration: 20,
      });
    }

    state.multiVoiceTracks = newVoices;
    writeProjectState(state, sessionId);
    return NextResponse.json({ success: true, sessionId, multiVoiceTracks: newVoices });
  }

  // Local file upload / folder scan (Mode phụ)
  if (formData) {
    const files = formData.getAll("files") as File[];
    const targetCategory = (formData.get("targetCategory") as string) || "";
    const addedItems: CategoryVideoItem[] = [];

    for (const file of files) {
      if (!file || typeof file === "string" || !file.name) continue;

      let detectedCat: ShotCategory = "product";
      const relativePath = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || "";
      const lowerRel = relativePath.toLowerCase();
      const fileName = path.basename(file.name);
      const lowerName = fileName.toLowerCase();

      if (lowerRel.includes("/open/") || lowerRel.includes("\\open\\") || lowerName.startsWith("open_") || targetCategory === "open") {
        detectedCat = "open";
      } else if (lowerRel.includes("/product/") || lowerRel.includes("\\product\\") || lowerName.startsWith("product_") || targetCategory === "product") {
        detectedCat = "product";
      } else if (lowerRel.includes("/texture/") || lowerRel.includes("\\texture\\") || lowerName.startsWith("texture_") || targetCategory === "texture") {
        detectedCat = "texture";
      } else if (lowerRel.includes("/apply/") || lowerRel.includes("\\apply\\") || lowerName.startsWith("apply_") || targetCategory === "apply") {
        detectedCat = "apply";
      } else if (lowerRel.includes("/end/") || lowerRel.includes("\\end\\") || lowerName.startsWith("end_") || targetCategory === "end") {
        detectedCat = "end";
      }

      const safeName = fileName.replace(/\s+/g, "_");
      const ext = path.extname(safeName).toLowerCase() || ".mp4";
      const fileHash = crypto.createHash("md5").update(safeName).digest("hex").slice(0, 8);
      const id = `clip_${detectedCat}_${fileHash}`;

      if (pools[detectedCat].some((it) => it.id === id || it.fileName === safeName)) {
        continue;
      }

      const catDir = path.join(sessionPaths.categoriesDir, detectedCat);
      if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

      const savedFileName = `${id}_${safeName}`;
      const filePath = path.join(catDir, savedFileName);

      const bytes = await file.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(bytes));

      const isLocked = lowerName.includes("_lock");
      const item: CategoryVideoItem = {
        id,
        name: safeName.replace(ext, ""),
        fileName: savedFileName,
        category: detectedCat,
        localUrl: `/api/media/sessions/${sessionId}/categories/${detectedCat}/${savedFileName}`,
        localPath: filePath,
        duration: 4.0,
        sizeBytes: bytes.byteLength,
        lockFlipH: isLocked,
        sourceType: "local",
      };

      pools[detectedCat].push(item);
      addedItems.push(item);
    }

    state.categoryPools = pools;
    writeProjectState(state, sessionId);

    return NextResponse.json({
      success: true,
      sessionId,
      addedCount: addedItems.length,
      categoryPools: pools,
    });
  }

  return NextResponse.json({ error: "Unsupported request" }, { status: 400 });
}
