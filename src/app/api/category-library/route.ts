import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
import {
  extractGoogleDriveFileId,
  probeGoogleDriveClipMetadata,
  probeGoogleDriveVoiceMetadata,
} from "@/lib/drive";
import {
  getProjectCategoryPools,
  getProjectVoiceTracks,
  resolveFolderAccess,
  saveProjectCategoryPools,
  saveProjectVoiceTracks,
} from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const VALID_CATS: ShotCategory[] = ["open", "product", "texture", "apply", "end"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qProjectId = url.searchParams.get("projectId");
  const qSessionId = url.searchParams.get("sessionId");
  const sessionId = sanitizeSessionId(qSessionId || getSessionIdFromHeaders(req.headers));

  ensureSessionDirs(sessionId);
  const state = readProjectState(sessionId);

  let pools: CategoryPools = state.categoryPools || {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  };

  if (qProjectId) {
    const [cloudPools, cloudVoices] = await Promise.all([
      getProjectCategoryPools(qProjectId),
      getProjectVoiceTracks(qProjectId),
    ]);
    const hasPoolItems = Object.values(cloudPools).some((arr) => arr.length > 0);
    if (hasPoolItems) {
      pools = cloudPools;
      state.categoryPools = pools;
    }
    if (cloudVoices.length > 0) {
      state.multiVoiceTracks = cloudVoices;
    }
    if (hasPoolItems || cloudVoices.length > 0) {
      writeProjectState(state, sessionId);
    }
  }

  return NextResponse.json({
    sessionId,
    categoryPools: pools,
    multiVoiceTracks: state.multiVoiceTracks || [],
  });
}

// Helper to run promises in parallel with concurrency limit
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 6
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const curIdx = index++;
      results[curIdx] = await fn(items[curIdx], curIdx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function POST(req: NextRequest) {
  cleanupExpiredSessions();

  // -------------------------------------------------------------
  // CHUNKED UPLOAD SUPPORT CHO FILE LẺ > 20MB
  // -------------------------------------------------------------
  const uploadId = req.headers.get("x-upload-id");
  const chunkIndexHeader = req.headers.get("x-chunk-index");
  if (uploadId && chunkIndexHeader !== null) {
    const chunkIndex = parseInt(chunkIndexHeader, 10);
    const totalChunks = parseInt(req.headers.get("x-total-chunks") || "1", 10);
    const rawFileName = req.headers.get("x-file-name") || "clip.mp4";
    const fileName = decodeURIComponent(rawFileName);
    const targetCategory = (req.headers.get("x-target-category") as string) || "product";
    const relativePath = decodeURIComponent(req.headers.get("x-relative-path") || "");
    const sessionId = sanitizeSessionId(
      req.headers.get("x-session-id") || getSessionIdFromHeaders(req.headers)
    );
    const projectId = req.headers.get("x-project-id") || "";

    if (projectId) {
      const user = await getCurrentUser();
      const access = await resolveFolderAccess(projectId, user?.id, user?.email);
      if (!access.isOwner && !access.permissions.mix?.actions?.includes("edit")) {
        return NextResponse.json(
          { error: "Bạn không có quyền chỉnh sửa kho clip của dự án này." },
          { status: 403 }
        );
      }
    }

    const sessionPaths = ensureSessionDirs(sessionId);
    const safeUploadId = uploadId.replace(/[^a-zA-Z0-9_-]/g, "");

    // Phân loại category
    let detectedCat: ShotCategory = "product";
    const lowerRel = relativePath.toLowerCase();
    const lowerName = fileName.toLowerCase();
    const isVoice = targetCategory === "voice" || lowerRel.includes("/voice/") || lowerRel.includes("\\voice\\");

    if (!isVoice) {
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
    }

    const targetDir = isVoice
      ? sessionPaths.voicesDir
      : path.join(sessionPaths.categoriesDir, detectedCat);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const partPath = path.join(targetDir, `${safeUploadId}.part`);
    const safeName = path.basename(fileName).replace(/\s+/g, "_");
    const ext = path.extname(safeName).toLowerCase() || (isVoice ? ".mp3" : ".mp4");
    const fileHash = crypto.createHash("md5").update(safeName).digest("hex").slice(0, 8);
    const itemId = isVoice ? `voice_${fileHash}` : `clip_${detectedCat}_${fileHash}`;
    const savedFileName = `${itemId}_${safeName}`;
    const finalDestPath = path.join(targetDir, savedFileName);

    if (chunkIndex === 0 && fs.existsSync(partPath)) {
      fs.unlinkSync(partPath);
    }

    if (!req.body) {
      return NextResponse.json({ error: "Không tìm thấy dữ liệu chunk stream." }, { status: 400 });
    }

    const nodeStream = Readable.fromWeb(req.body as any);
    const writeStream = fs.createWriteStream(partPath, {
      flags: chunkIndex === 0 ? "w" : "a",
    });
    await pipeline(nodeStream, writeStream);

    if (chunkIndex < totalChunks - 1) {
      const stats = fs.statSync(partPath);
      return NextResponse.json({
        partial: true,
        chunkIndex,
        totalChunks,
        receivedBytes: stats.size,
      });
    }

    // Chunk cuối cùng -> Đổi tên thành file thật và cập nhật kho
    if (fs.existsSync(finalDestPath)) {
      fs.unlinkSync(finalDestPath);
    }
    fs.renameSync(partPath, finalDestPath);

    const stats = fs.statSync(finalDestPath);
    const state = readProjectState(sessionId);
    const pools: CategoryPools = state.categoryPools || {
      open: [],
      product: [],
      texture: [],
      apply: [],
      end: [],
    };

    if (isVoice) {
      const curVoices = state.multiVoiceTracks || [];
      const newVoice: MultiVoiceItem = {
        id: itemId,
        name: safeName.replace(ext, ""),
        fileName: savedFileName,
        localUrl: `/api/media/sessions/${sessionId}/voices/${savedFileName}`,
        localPath: finalDestPath,
        duration: 20,
        sourceType: "local",
      };
      // Tránh trùng lặp
      if (!curVoices.some((v) => v.id === itemId || v.fileName === savedFileName)) {
        curVoices.push(newVoice);
      }
      state.multiVoiceTracks = curVoices;
      writeProjectState(state, sessionId);
      if (projectId) {
        await saveProjectVoiceTracks(projectId, curVoices);
      }
      return NextResponse.json({
        success: true,
        sessionId,
        completed: true,
        multiVoiceTracks: curVoices,
        categoryPools: pools,
      });
    }

    const isLocked = lowerName.includes("_lock");
    const item: CategoryVideoItem = {
      id: itemId,
      name: safeName.replace(ext, ""),
      fileName: savedFileName,
      category: detectedCat,
      localUrl: `/api/media/sessions/${sessionId}/categories/${detectedCat}/${savedFileName}`,
      localPath: finalDestPath,
      duration: 4.0,
      sizeBytes: stats.size,
      lockFlipH: isLocked,
      sourceType: "local",
      contentHash: fileHash,
    };

    if (!pools[detectedCat].some((it) => it.id === itemId || it.fileName === savedFileName)) {
      pools[detectedCat].push(item);
    }

    state.categoryPools = pools;
    writeProjectState(state, sessionId);
    if (projectId) {
      await saveProjectCategoryPools(projectId, pools);
    }

    return NextResponse.json({
      success: true,
      sessionId,
      completed: true,
      addedItem: item,
      categoryPools: pools,
      multiVoiceTracks: state.multiVoiceTracks || [],
    });
  }

  const contentType = req.headers.get("content-type") || "";
  let action = "upload";
  let sessionId = "";
  let projectId = "";
  let jsonData: Record<string, unknown> | null = null;
  let formData: FormData | null = null;

  if (contentType.includes("application/json")) {
    jsonData = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    action = (jsonData?.action as string) || "ingest_drive_links";
    sessionId = sanitizeSessionId(
      (jsonData?.sessionId as string) || getSessionIdFromHeaders(req.headers)
    );
    projectId = (jsonData?.projectId as string) || "";
  } else {
    formData = await req.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
    }
    action = (formData.get("action") as string) || "upload";
    sessionId = sanitizeSessionId(
      (formData.get("sessionId") as string) || getSessionIdFromHeaders(req.headers)
    );
    projectId = (formData.get("projectId") as string) || "";
  }

  if (projectId) {
    const user = await getCurrentUser();
    const access = await resolveFolderAccess(projectId, user?.id, user?.email);
    if (!access.isOwner && !access.permissions.mix?.actions?.includes("edit")) {
      return NextResponse.json(
        { error: "Bạn không có quyền chỉnh sửa kho clip của dự án này." },
        { status: 403 }
      );
    }
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
    let categoryLinksMap: Partial<Record<ShotCategory | "voice", string[]>> = {};

    if (jsonData?.categoryLinks && typeof jsonData.categoryLinks === "object") {
      categoryLinksMap = jsonData.categoryLinks as Partial<Record<ShotCategory | "voice", string[]>>;
    } else if (jsonData?.targetCategory && Array.isArray(jsonData?.links)) {
      const cat = jsonData.targetCategory as string;
      if (VALID_CATS.includes(cat as ShotCategory) || cat === "voice") {
        categoryLinksMap[cat as ShotCategory | "voice"] = jsonData.links as string[];
      }
    } else if (formData) {
      const targetCat = (formData.get("targetCategory") as string) || "product";
      const rawLinks = (formData.get("links") as string) || "";
      if (VALID_CATS.includes(targetCat as ShotCategory) || targetCat === "voice") {
        categoryLinksMap[targetCat as ShotCategory | "voice"] = rawLinks
          .split(/[\r\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const videoTasks: { category: ShotCategory; fileId: string }[] = [];
    const voiceTasks: { fileId: string }[] = [];
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
        if (alreadyExists || videoTasks.some((t) => t.category === cat && t.fileId === fileId)) {
          duplicateCount++;
          continue;
        }

        videoTasks.push({ category: cat, fileId });
      }
    }

    const voiceLinks = categoryLinksMap["voice"] || [];
    const currentVoices: MultiVoiceItem[] = state.multiVoiceTracks || [];
    for (const raw of voiceLinks) {
      const fileId = extractGoogleDriveFileId(raw);
      if (!fileId) continue;

      const alreadyExists = currentVoices.some(
        (v) => v.driveFileId === fileId || v.id.includes(fileId.slice(0, 10))
      );
      if (alreadyExists || voiceTasks.some((t) => t.fileId === fileId)) {
        duplicateCount++;
        continue;
      }

      voiceTasks.push({ fileId });
    }

    if (videoTasks.length === 0 && voiceTasks.length === 0) {
      return NextResponse.json({
        success: true,
        sessionId,
        addedCount: 0,
        duplicateCount,
        errors: [],
        categoryPools: pools,
        multiVoiceTracks: currentVoices,
        message: duplicateCount > 0 ? "Toàn bộ link đã có sẵn trong kho." : "Không có link hợp lệ.",
      });
    }

    const errors: { fileId: string; category: string; error: string }[] = [];
    const addedVideoItems: CategoryVideoItem[] = [];
    const addedVoiceItems: MultiVoiceItem[] = [];

    // Probe all video and voice tasks simultaneously in RAM (up to 24 parallel workers)
    const [videoProbeResults, voiceProbeResults] = await Promise.all([
      videoTasks.length > 0
        ? pMap(
            videoTasks,
            async (task, idx) => {
              const probe = await probeGoogleDriveClipMetadata(task.fileId);
              return { category: task.category, probe, idx };
            },
            24
          )
        : Promise.resolve([]),
      voiceTasks.length > 0
        ? pMap(
            voiceTasks,
            async (task, idx) => {
              const probe = await probeGoogleDriveVoiceMetadata(
                task.fileId,
                currentVoices.length + idx + 1
              );
              return { probe, idx };
            },
            24
          )
        : Promise.resolve([]),
    ]);

    for (const res of videoProbeResults) {
      const { category, probe, idx } = res;
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
        id: `drive_${category}_${probe.fileId}`,
        name: safeBase,
        fileName: probe.fileName,
        category,
        localUrl: `/api/drive-stream/${probe.fileId}`,
        duration: probe.duration || 4.0,
        sizeBytes: probe.sizeBytes,
        lockFlipH: probe.lockFlipH,
        driveFileId: probe.fileId,
        sourceType: "drive",
        contentHash: probe.contentHash,
      };

      pools[category].push(item);
      addedVideoItems.push(item);
    }

    for (const res of voiceProbeResults) {
      const { probe, idx } = res;
      if (!probe.success) {
        errors.push({
          fileId: probe.fileId,
          category: "voice",
          error: probe.error || "Không thể tải metadata voice từ Google Drive",
        });
        continue;
      }

      const voiceItem: MultiVoiceItem = {
        id: `drive_voice_${probe.fileId.slice(0, 12)}_${idx}_${Date.now().toString(36)}`,
        name: probe.name,
        fileName: probe.fileName,
        localUrl: `/api/drive-stream/${probe.fileId}`,
        localPath: "",
        duration: probe.duration || 20.0,
        sourceType: "drive",
        driveFileId: probe.fileId,
        driveRawUrl: `https://drive.google.com/file/d/${probe.fileId}/view`,
      };

      currentVoices.push(voiceItem);
      addedVoiceItems.push(voiceItem);
    }

    state.categoryPools = pools;
    state.multiVoiceTracks = currentVoices;
    writeProjectState(state, sessionId);

    if (projectId) {
      await Promise.all([
        saveProjectCategoryPools(projectId, pools),
        saveProjectVoiceTracks(projectId, currentVoices),
      ]);
    }

    return NextResponse.json({
      success: true,
      sessionId,
      addedCount: addedVideoItems.length + addedVoiceItems.length,
      duplicateCount,
      errors,
      categoryPools: pools,
      multiVoiceTracks: currentVoices,
    });
  }

  // Remove single voice
  if (action === "remove_voice") {
    const voiceId = (formData?.get("voiceId") || jsonData?.voiceId) as string;
    const currentVoices = state.multiVoiceTracks || [];
    const targetVoice = currentVoices.find((v) => v.id === voiceId);
    if (targetVoice?.localPath && fs.existsSync(targetVoice.localPath)) {
      try {
        fs.unlinkSync(targetVoice.localPath);
      } catch {
        // Ignore
      }
    }
    state.multiVoiceTracks = currentVoices.filter((v) => v.id !== voiceId);
    writeProjectState(state, sessionId);
    if (projectId) {
      await saveProjectVoiceTracks(projectId, state.multiVoiceTracks);
    }
    return NextResponse.json({ success: true, sessionId, multiVoiceTracks: state.multiVoiceTracks });
  }

  // Clear all voices
  if (action === "clear_voices") {
    const currentVoices = state.multiVoiceTracks || [];
    for (const v of currentVoices) {
      if (v.localPath && fs.existsSync(v.localPath)) {
        try {
          fs.unlinkSync(v.localPath);
        } catch {
          // Ignore
        }
      }
    }
    state.multiVoiceTracks = [];
    writeProjectState(state, sessionId);
    if (projectId) {
      await saveProjectVoiceTracks(projectId, []);
    }
    return NextResponse.json({ success: true, sessionId, multiVoiceTracks: [] });
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

    if (projectId) {
      await saveProjectCategoryPools(projectId, pools);
    }
    return NextResponse.json({ success: true, sessionId, categoryPools: pools });
  }

  // Clear all categories, voices, and combinations
  if (action === "clear_all") {
    clearSessionCategories(sessionId);
    pools.open = [];
    pools.product = [];
    pools.texture = [];
    pools.apply = [];
    pools.end = [];
    state.categoryPools = pools;
    state.multiVoiceTracks = [];
    state.composedVideos = [];
    writeProjectState(state, sessionId);

    if (projectId) {
      await Promise.all([
        saveProjectCategoryPools(projectId, pools),
        saveProjectVoiceTracks(projectId, []),
      ]);
    }

    return NextResponse.json({
      success: true,
      sessionId,
      categoryPools: pools,
      multiVoiceTracks: [],
      composedVideos: [],
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

    if (projectId) {
      await saveProjectCategoryPools(projectId, pools);
    }
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
    if (projectId) {
      await saveProjectVoiceTracks(projectId, newVoices);
    }
    return NextResponse.json({ success: true, sessionId, multiVoiceTracks: newVoices });
  }

  // Local file upload / folder scan (Mode phụ)
  if (formData) {
    const files = formData.getAll("files") as File[];
    const targetCategory = (formData.get("targetCategory") as string) || "";
    const addedItems: CategoryVideoItem[] = [];

    for (const file of files) {
      if (!file || typeof file === "string" || !file.name) continue;

      const fileName = path.basename(file.name);
      if (targetCategory === "voice") {
        const safeName = fileName.replace(/\s+/g, "_");
        const ext = path.extname(safeName).toLowerCase() || ".mp3";
        const id = `voice_${crypto.randomBytes(4).toString("hex")}`;
        const savedFileName = `${id}_${safeName}`;
        const filePath = path.join(sessionPaths.voicesDir, savedFileName);
        const bytes = await file.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(bytes));

        const newVoice: MultiVoiceItem = {
          id,
          name: safeName.replace(ext, ""),
          fileName: savedFileName,
          localUrl: `/api/media/sessions/${sessionId}/voices/${savedFileName}`,
          localPath: filePath,
          duration: 20,
          sourceType: "local",
        };
        const curVoices = state.multiVoiceTracks || [];
        curVoices.push(newVoice);
        state.multiVoiceTracks = curVoices;
        continue;
      }

      let detectedCat: ShotCategory = "product";
      const relativePath = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || "";
      const lowerRel = relativePath.toLowerCase();
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
        contentHash: fileHash,
      };

      pools[detectedCat].push(item);
      addedItems.push(item);
    }

    state.categoryPools = pools;
    writeProjectState(state, sessionId);

    if (projectId) {
      await Promise.all([
        saveProjectCategoryPools(projectId, pools),
        saveProjectVoiceTracks(projectId, state.multiVoiceTracks || []),
      ]);
    }

    return NextResponse.json({
      success: true,
      sessionId,
      addedCount: addedItems.length,
      categoryPools: pools,
      multiVoiceTracks: state.multiVoiceTracks || [],
    });
  }

  return NextResponse.json({ error: "Unsupported request" }, { status: 400 });
}
