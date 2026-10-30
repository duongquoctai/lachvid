import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, readProjectState, writeProjectState } from "@/lib/store";
import { CategoryPools, CategoryVideoItem, MultiVoiceItem, ShotCategory } from "@/types/lachvid";

const CATEGORIES_DIR = path.join(DATA_DIR, "uploads", "categories");
const VOICES_DIR = path.join(DATA_DIR, "uploads", "voices");

const VALID_CATS: ShotCategory[] = ["open", "product", "texture", "apply", "end"];

function ensureDirs() {
  if (!fs.existsSync(CATEGORIES_DIR)) {
    fs.mkdirSync(CATEGORIES_DIR, { recursive: true });
  }
  for (const c of VALID_CATS) {
    const cDir = path.join(CATEGORIES_DIR, c);
    if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
  }
  if (!fs.existsSync(VOICES_DIR)) {
    fs.mkdirSync(VOICES_DIR, { recursive: true });
  }
}

export async function GET() {
  ensureDirs();
  const state = readProjectState();

  const pools: CategoryPools = state.categoryPools || {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  };

  return NextResponse.json({
    categoryPools: pools,
    multiVoiceTracks: state.multiVoiceTracks || [],
  });
}

export async function POST(req: NextRequest) {
  ensureDirs();
  const formData = await req.formData().catch(() => null);

  if (!formData) {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const action = (formData.get("action") as string) || "upload";
  const state = readProjectState();

  const pools: CategoryPools = state.categoryPools || {
    open: [],
    product: [],
    texture: [],
    apply: [],
    end: [],
  };

  if (action === "clear_category") {
    const category = (formData.get("category") as ShotCategory) || "open";
    if (pools[category]) {
      pools[category] = [];
    }
    state.categoryPools = pools;
    writeProjectState(state);
    return NextResponse.json({ success: true, categoryPools: pools });
  }

  if (action === "clear_all") {
    pools.open = [];
    pools.product = [];
    pools.texture = [];
    pools.apply = [];
    pools.end = [];
    state.categoryPools = pools;
    state.multiVoiceTracks = [];
    writeProjectState(state);
    return NextResponse.json({ success: true, categoryPools: pools, multiVoiceTracks: [] });
  }

  if (action === "remove_item") {
    const itemId = formData.get("itemId") as string;
    const category = formData.get("category") as ShotCategory;
    if (category && pools[category]) {
      pools[category] = pools[category].filter((i) => i.id !== itemId);
    }
    state.categoryPools = pools;
    writeProjectState(state);
    return NextResponse.json({ success: true, categoryPools: pools });
  }

  if (action === "upload_voice") {
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
      const filePath = path.join(VOICES_DIR, savedFileName);

      fs.writeFileSync(filePath, buffer);

      newVoices.push({
        id,
        name: safeName.replace(ext, ""),
        fileName: savedFileName,
        localUrl: `/api/media/uploads/voices/${savedFileName}`,
        localPath: filePath,
        duration: 20, // default placeholder until parsed
      });
    }

    state.multiVoiceTracks = newVoices;
    writeProjectState(state);
    return NextResponse.json({ success: true, multiVoiceTracks: newVoices });
  }

  // Upload category files / folder scan
  // Files can have relative webkitRelativePath such as "MyFolders/OPEN/clip1.mp4"
  const files = formData.getAll("files") as File[];
  const targetCategory = (formData.get("targetCategory") as string) || "";

  const addedItems: CategoryVideoItem[] = [];

  for (const file of files) {
    if (!file || typeof file === "string" || !file.name) continue;

    // Detect category from folder path if available, or targetCategory, or filename prefix
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

    // Check if already in pool
    if (pools[detectedCat].some((it) => it.id === id || it.fileName === safeName)) {
      continue;
    }

    const catDir = path.join(CATEGORIES_DIR, detectedCat);
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
      localUrl: `/api/media/uploads/categories/${detectedCat}/${savedFileName}`,
      localPath: filePath,
      duration: 4.0, // default placeholder
      sizeBytes: bytes.byteLength,
      lockFlipH: isLocked,
    };

    pools[detectedCat].push(item);
    addedItems.push(item);
  }

  state.categoryPools = pools;
  writeProjectState(state);

  return NextResponse.json({
    success: true,
    addedCount: addedItems.length,
    categoryPools: pools,
  });
}
