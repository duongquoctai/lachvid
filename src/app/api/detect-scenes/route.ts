import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { readProjectState, writeProjectState } from "@/lib/store";
import {
  CategoryMinDurations,
  computeShotSpeedForMinDuration,
  DEFAULT_CATEGORY_MIN_DURATIONS,
  Shot,
  ShotCategory,
} from "@/types/lachvid";

const PYTHON_BACKEND_URL =
  process.env.PYTHON_BACKEND_URL || "http://localhost:8000";

interface PythonSceneItem {
  index: number;
  start_seconds: float;
  end_seconds: float;
  duration: float;
  start_frame: int;
  end_frame: int;
}

type float = number;
type int = number;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const detector = body.detector || "content"; // "content" | "adaptive"
    const threshold = Number(body.threshold || 27.0);
    const minSceneLen = Number(body.minSceneLen || 0.8);

    const state = readProjectState();
    if (!state.sourceVideo) {
      return NextResponse.json(
        { error: "Chưa có source video để phân tích." },
        { status: 400 }
      );
    }

    const categoryMinDurations: CategoryMinDurations = {
      ...DEFAULT_CATEGORY_MIN_DURATIONS,
      ...(state.categoryMinDurations || {}),
      ...(body.categoryMinDurations || {}),
    };
    state.categoryMinDurations = categoryMinDurations;

    let scenes: PythonSceneItem[] = [];

    // Cách 1: Nếu file local tồn tại (môi trường Local hoặc VPS), gọi endpoint /detect-local
    // để Python đọc trực tiếp từ đĩa với tốc độ siêu nhanh (không tốn băng thông)
    if (state.sourceVideo.localPath && fs.existsSync(state.sourceVideo.localPath)) {
      try {
        const pyRes = await fetch(`${PYTHON_BACKEND_URL}/detect-local`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_path: state.sourceVideo.localPath,
            detector,
            threshold,
            min_scene_len: minSceneLen,
          }),
        });

        if (pyRes.ok) {
          const data = await pyRes.json();
          scenes = data.scenes || [];
        } else {
          const errData = await pyRes.json().catch(() => ({}));
          throw new Error(errData.detail || `Python backend HTTP ${pyRes.status}`);
        }
      } catch {
        // Fallback sang Cách 2 nếu /detect-local không khả dụng (ví dụ khi deploy Cloud A)
        scenes = await uploadAndDetectRemote(
          state.sourceVideo.localPath,
          state.sourceVideo.fileName,
          detector,
          threshold,
          minSceneLen
        );
      }
    } else {
      return NextResponse.json(
        { error: "Không tìm thấy file video trên hệ thống." },
        { status: 404 }
      );
    }

    if (!scenes || scenes.length === 0) {
      return NextResponse.json(
        { error: "PySceneDetect không tìm thấy phân cảnh nào." },
        { status: 422 }
      );
    }

    // Gom các phân cảnh nhỏ của PySceneDetect thành các Shot chuẩn theo Số Giây Tối Thiểu (Min Giây) của 5 Category.
    // Nếu một phân cảnh sau khi gom vẫn ngắn hơn minDuration, tự động áp dụng Slow-motion để đảm bảo đủ số giây tối thiểu.
    const totalVideoDur = scenes[scenes.length - 1].end_seconds;
    let slowMoCount = 0;

    // Tìm điểm bắt đầu cho cảnh END (CTA) ở cuối video sao cho đoạn kết đạt ít nhất minDuration của 'end'
    const minEndDur = categoryMinDurations.end || DEFAULT_CATEGORY_MIN_DURATIONS.end || 4.0;
    let endStart = scenes[scenes.length - 1].start_seconds;
    let endCutIndex = scenes.length - 1;

    if (scenes.length >= 2) {
      for (let i = scenes.length - 1; i >= 1; i--) {
        const candidateStart = scenes[i].start_seconds;
        if (totalVideoDur - candidateStart >= minEndDur) {
          endStart = candidateStart;
          endCutIndex = i;
          break;
        }
      }
    }

    // Chu kỳ phân bổ category cho các cảnh từ đầu video tới endStart
    const categoryCycle: ShotCategory[] = ["open", "product", "texture", "apply"];
    const loopPool: ShotCategory[] = ["apply", "product", "texture"];
    let catSeqIndex = 0;
    let currentCutIndex = 0;
    let curStart = scenes[0].start_seconds;

    const generatedShots: Shot[] = [];

    while (currentCutIndex < endCutIndex) {
      let cat: ShotCategory;
      if (catSeqIndex < categoryCycle.length) {
        cat = categoryCycle[catSeqIndex];
      } else {
        cat = loopPool[(catSeqIndex - categoryCycle.length) % loopPool.length];
      }
      catSeqIndex++;

      const targetMin = categoryMinDurations[cat] ?? DEFAULT_CATEGORY_MIN_DURATIONS[cat];
      let segEnd = scenes[currentCutIndex].end_seconds;
      currentCutIndex++;

      // Tiếp tục gom các nhát cắt kế tiếp cho tới khi đạt số giây tối thiểu của category
      while (currentCutIndex < endCutIndex && (segEnd - curStart) < targetMin) {
        segEnd = scenes[currentCutIndex].end_seconds;
        currentCutIndex++;
      }

      const rawDur = Number((segEnd - curStart).toFixed(2));
      const computedSpeed = computeShotSpeedForMinDuration(rawDur, targetMin);
      if (computedSpeed < 0.999) {
        slowMoCount++;
      }

      const catLabel =
        cat === "open"
          ? "Open (Hook)"
          : cat === "product"
          ? "Product"
          : cat === "texture"
          ? "Texture"
          : "Apply / Use";

      generatedShots.push({
        id: `shot_pyscene_${generatedShots.length + 1}_${Date.now()}`,
        sourceVideoId: state.sourceVideo!.id,
        label: `${catLabel} - Cảnh #${generatedShots.length + 1}`,
        begin: curStart,
        end: segEnd,
        rawBegin: curStart,
        rawEnd: segEnd,
        category: cat,
        edits: {
          flipH: false,
          lockFlipH: true,
          speed: computedSpeed,
          zoom: false,
        },
      });

      curStart = segEnd;
    }

    // Thêm Cảnh END (CTA) kết thúc video
    const endRawDur = Number((totalVideoDur - endStart).toFixed(2));
    const endComputedSpeed = computeShotSpeedForMinDuration(endRawDur, minEndDur);
    if (endComputedSpeed < 0.999) {
      slowMoCount++;
    }

    generatedShots.push({
      id: `shot_pyscene_${generatedShots.length + 1}_${Date.now()}`,
      sourceVideoId: state.sourceVideo!.id,
      label: `End (CTA) - Cảnh #${generatedShots.length + 1}`,
      begin: endStart,
      end: totalVideoDur,
      rawBegin: endStart,
      rawEnd: totalVideoDur,
      category: "end",
      edits: {
        flipH: false,
        lockFlipH: true,
        speed: endComputedSpeed,
        zoom: false,
      },
    });

    state.shots = generatedShots;
    state.composedVideos = [];
    writeProjectState(state);

    return NextResponse.json({
      success: true,
      totalScenes: scenes.length,
      slowMoCount,
      shots: generatedShots,
      state,
      engine: "PySceneDetect (ContentDetector + OpenCV)",
      threshold,
      minSceneLen,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Lỗi kết nối tới PySceneDetect service",
        hint: `Hãy đảm bảo Python Backend đang chạy tại ${PYTHON_BACKEND_URL} (hoặc kiểm tra log backend)`,
      },
      { status: 500 }
    );
  }
}

async function uploadAndDetectRemote(
  filePath: string,
  fileName: string,
  detector: string,
  threshold: number,
  minSceneLen: number
): Promise<PythonSceneItem[]> {
  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: "video/mp4" });
  const form = new FormData();
  form.append("file", blob, fileName);
  form.append("detector", detector);
  form.append("threshold", String(threshold));
  form.append("min_scene_len", String(minSceneLen));

  const res = await fetch(`${PYTHON_BACKEND_URL}/detect-upload`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Upload stream to Python failed (${res.status})`);
  }

  const data = await res.json();
  return data.scenes || [];
}
