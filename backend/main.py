import io
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
from typing import List, Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel
from scenedetect import open_video, SceneManager, ContentDetector, AdaptiveDetector

app = FastAPI(
    title="LachVid PySceneDetect & FFmpeg Service",
    description="Microservice phân tích frame và xử lý video không lưu rác cho LachVid Studio",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Concurrency Semaphore: Max 3 heavy FFmpeg / PySceneDetect tasks in parallel
WORKER_SEMAPHORE = threading.BoundedSemaphore(3)

# -------------------------------------------------------------
# BACKGROUND CLEANUP JANITOR (TTL 30 mins, Max 5GB)
# -------------------------------------------------------------
SESSION_TTL_SECONDS = 30 * 60  # 30 minutes
MAX_STORAGE_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB

def get_base_sessions_dir() -> str:
    return os.path.join(tempfile.get_tempdir(), "lachvid_sessions")

def cleanup_expired_sessions_janitor():
    """Background thread that runs every 5 minutes to purge inactive sessions."""
    while True:
        try:
            base_dir = get_base_sessions_dir()
            if os.path.exists(base_dir):
                now = time.time()
                total_bytes = 0
                session_stats = []

                for item in os.listdir(base_dir):
                    item_path = os.path.join(base_dir, item)
                    if not os.path.isdir(item_path):
                        continue
                    try:
                        mtime = os.path.getmtime(item_path)
                        # Check TTL
                        if now - mtime > SESSION_TTL_SECONDS:
                            shutil.rmtree(item_path, ignore_errors=True)
                            continue

                        # Calculate directory size
                        sz = sum(
                            os.path.getsize(os.path.join(dirpath, f))
                            for dirpath, _, filenames in os.walk(item_path)
                            for f in filenames
                        )
                        total_bytes += sz
                        session_stats.append((item_path, mtime, sz))
                    except Exception:
                        pass

                # If exceeding 5GB, evict oldest session
                if total_bytes > MAX_STORAGE_BYTES:
                    session_stats.sort(key=lambda x: x[1])  # oldest mtime first
                    for path, _, sz in session_stats:
                        if total_bytes <= MAX_STORAGE_BYTES:
                            break
                        shutil.rmtree(path, ignore_errors=True)
                        total_bytes -= sz
        except Exception:
            pass
        time.sleep(300)  # Sleep 5 minutes

# Start the janitor daemon thread
janitor_thread = threading.Thread(target=cleanup_expired_sessions_janitor, daemon=True)
janitor_thread.start()

# -------------------------------------------------------------
# PYSCENEDETECT MODELS & FUNCTIONS
# -------------------------------------------------------------
class SceneItem(BaseModel):
    index: int
    start_seconds: float
    end_seconds: float
    duration: float
    start_frame: int
    end_frame: int

class DetectResponse(BaseModel):
    success: bool
    total_scenes: int
    scenes: List[SceneItem]
    method: str
    threshold: float
    min_scene_len: float

class DetectLocalPathRequest(BaseModel):
    file_path: str
    detector: Optional[str] = "content"  # "content" or "adaptive"
    threshold: Optional[float] = 27.0
    min_scene_len: Optional[float] = 0.8  # seconds

def analyze_video_scenes(
    video_path: str,
    detector_type: str = "content",
    threshold: float = 27.0,
    min_scene_len: float = 0.8
) -> List[SceneItem]:
    if not os.path.exists(video_path):
        raise HTTPException(status_code=404, detail=f"File không tồn tại: {video_path}")

    video = open_video(video_path)
    fps = video.frame_rate
    min_len_frames = max(1, int(min_scene_len * fps))

    scene_manager = SceneManager()

    if detector_type == "adaptive":
        scene_manager.add_detector(
            AdaptiveDetector(adaptive_threshold=threshold, min_scene_len=min_len_frames)
        )
    else:
        scene_manager.add_detector(
            ContentDetector(threshold=threshold, min_scene_len=min_len_frames)
        )

    scene_manager.detect_scenes(video=video)
    scene_list = scene_manager.get_scene_list()

    scenes: List[SceneItem] = []
    for idx, (start_time, end_time) in enumerate(scene_list):
        scenes.append(
            SceneItem(
                index=idx + 1,
                start_seconds=round(start_time.get_seconds(), 2),
                end_seconds=round(end_time.get_seconds(), 2),
                duration=round((end_time - start_time).get_seconds(), 2),
                start_frame=start_time.get_frames(),
                end_frame=end_time.get_frames(),
            )
        )

    if not scenes and video.duration:
        total_sec = round(video.duration.get_seconds(), 2)
        scenes.append(
            SceneItem(
                index=1,
                start_seconds=0.0,
                end_seconds=total_sec,
                duration=total_sec,
                start_frame=0,
                end_frame=video.duration.get_frames(),
            )
        )

    return scenes

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "lachvid-pyscenedetect", "version": "2.0.0"}

@app.post("/detect-local", response_model=DetectResponse)
def detect_scenes_from_local_path(req: DetectLocalPathRequest):
    with WORKER_SEMAPHORE:
        scenes = analyze_video_scenes(
            video_path=req.file_path,
            detector_type=req.detector or "content",
            threshold=req.threshold or 27.0,
            min_scene_len=req.min_scene_len or 0.8,
        )
        return DetectResponse(
            success=True,
            total_scenes=len(scenes),
            scenes=scenes,
            method=req.detector or "content",
            threshold=req.threshold or 27.0,
            min_scene_len=req.min_scene_len or 0.8,
        )

@app.post("/detect-upload", response_model=DetectResponse)
async def detect_scenes_from_uploaded_file(
    file: UploadFile = File(...),
    detector: str = Form("content"),
    threshold: float = Form(27.0),
    min_scene_len: float = Form(0.8),
):
    with WORKER_SEMAPHORE:
        suffix = os.path.splitext(file.filename or "")[1] or ".mp4"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name

        try:
            scenes = analyze_video_scenes(
                video_path=tmp_path,
                detector_type=detector,
                threshold=threshold,
                min_scene_len=min_scene_len,
            )
            return DetectResponse(
                success=True,
                total_scenes=len(scenes),
                scenes=scenes,
                method=detector,
                threshold=threshold,
                min_scene_len=min_scene_len,
            )
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

# -------------------------------------------------------------
# SLICE SCENES (Ephemeral memory / Auto self-destruct)
# -------------------------------------------------------------
class SliceSceneItem(BaseModel):
    id: str
    begin: float
    end: float
    category: str
    label: Optional[str] = None
    speed: Optional[float] = 1.0
    min_duration: Optional[float] = None
    flip_h: Optional[bool] = False
    lock_flip_h: Optional[bool] = False

class SliceVideoRequest(BaseModel):
    file_path: str
    scenes: List[SliceSceneItem]
    session_id: Optional[str] = None

@app.post("/slice-scenes")
def slice_scenes_endpoint(req: SliceVideoRequest):
    """
    Cắt video thành các file .mp4 riêng biệt và nén ZIP trực tiếp trong vùng nhớ tạm tự hủy.
    Không lưu bất kỳ file cảnh cắt nào trên đĩa sau khi request hoàn thành.
    """
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail=f"File nguồn không tồn tại: {req.file_path}")

    with WORKER_SEMAPHORE:
        import subprocess
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

        probe = subprocess.run([ffmpeg_exe, "-i", req.file_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        has_audio = "Audio:" in probe.stderr

        valid_categories = {"OPEN", "PRODUCT", "TEXTURE", "APPLY", "END"}

        # Ephemeral directory that self-destructs immediately when leaving block
        with tempfile.TemporaryDirectory() as ephemeral_dir:
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zipf:
                for idx, sc in enumerate(req.scenes):
                    cat_upper = sc.category.upper().strip()
                    if cat_upper not in valid_categories:
                        cat_upper = "PRODUCT"

                    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", sc.id) or f"shot_{idx+1}"
                    lock_tag = "_lock" if sc.lock_flip_h else ""
                    file_name = f"{cat_upper.lower()}_{safe_id}{lock_tag}.mp4"
                    out_file_path = os.path.join(ephemeral_dir, file_name)

                    raw_dur = max(0.1, sc.end - sc.begin)
                    target_speed = sc.speed if (sc.speed and sc.speed > 0) else 1.0

                    if sc.min_duration and sc.min_duration > 0 and raw_dur < sc.min_duration:
                        target_speed = min(target_speed, raw_dur / sc.min_duration)

                    target_speed = round(target_speed, 4)

                    vf_filters = []
                    if abs(target_speed - 1.0) > 0.005:
                        vf_filters.append(f"setpts={1.0 / target_speed:.4f}*PTS")
                    if sc.flip_h:
                        vf_filters.append("hflip")

                    audio_filters = []
                    if has_audio and abs(target_speed - 1.0) > 0.005:
                        tempo = target_speed
                        while tempo < 0.5:
                            audio_filters.append("atempo=0.5")
                            tempo /= 0.5
                        while tempo > 2.0:
                            audio_filters.append("atempo=2.0")
                            tempo /= 2.0
                        if abs(tempo - 1.0) > 0.005:
                            audio_filters.append(f"atempo={tempo:.4f}")

                    cmd = [
                        ffmpeg_exe,
                        "-y",
                        "-ss", f"{sc.begin:.3f}",
                        "-to", f"{sc.end:.3f}",
                        "-i", req.file_path,
                    ]

                    if vf_filters:
                        cmd.extend(["-vf", ",".join(vf_filters)])

                    if audio_filters:
                        cmd.extend(["-af", ",".join(audio_filters)])

                    cmd.extend([
                        "-c:v", "libx264",
                        "-preset", "veryfast",
                        "-crf", "19",
                        "-c:a", "aac",
                        "-movflags", "+faststart",
                        out_file_path,
                    ])

                    try:
                        subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
                        # Add into zip under its category folder
                        arc_name = f"{cat_upper}/{file_name}"
                        zipf.write(out_file_path, arcname=arc_name)
                    except subprocess.CalledProcessError as e:
                        err_msg = e.stderr.decode("utf-8", errors="ignore")
                        raise HTTPException(status_code=500, detail=f"Lỗi khi cắt cảnh {file_name}: {err_msg[:300]}")

            zip_buffer.seek(0)
            session_id = req.session_id or "export"
            return Response(
                content=zip_buffer.getvalue(),
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="lachvid_categories_{session_id}.zip"',
                    "X-Total-Sliced": str(len(req.scenes)),
                },
            )

# -------------------------------------------------------------
# RENDER COMPOSED (Ephemeral memory / Auto self-destruct)
# -------------------------------------------------------------
class RenderComposedSlot(BaseModel):
    category: str
    file_path: Optional[str] = None
    url: Optional[str] = None
    video_begin: float = 0.0
    video_end: float = 0.0
    speed: float = 1.0
    flip_h: bool = False

class RenderComposedVideoItem(BaseModel):
    id: str
    name: str
    slots: List[RenderComposedSlot]
    voice_file_path: Optional[str] = None
    voice_url: Optional[str] = None

class RenderBatchRequest(BaseModel):
    session_id: Optional[str] = None
    videos: List[RenderComposedVideoItem]

def resolve_disk_path(file_path: Optional[str], url: Optional[str]) -> Optional[str]:
    """Tìm đường dẫn thực tế trên đĩa từ file_path hoặc url."""
    if file_path and os.path.exists(file_path):
        return os.path.abspath(file_path)
    if url:
        clean = url.split("?")[0].strip()
        # Check sessions path
        base_sessions = get_base_sessions_dir()
        if "/api/media/sessions/" in clean:
            rel = clean.split("/api/media/sessions/")[1]
            p = os.path.join(base_sessions, rel)
            if os.path.exists(p):
                return p

        # Check legacy data directory
        if clean.startswith("/api/media/"):
            clean = clean[len("/api/media/"):]
        elif clean.startswith("api/media/"):
            clean = clean[len("api/media/"):]

        base_data = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
        p1 = os.path.join(base_data, clean)
        if os.path.exists(p1):
            return p1
        p2 = os.path.join(base_data, "outputs", clean)
        if os.path.exists(p2):
            return p2
        p3 = os.path.join(base_data, "uploads", os.path.basename(clean))
        if os.path.exists(p3):
            return p3
    return None

@app.post("/render-composed")
def render_composed_endpoint(req: RenderBatchRequest):
    """
    Render các tổ hợp video thành MP4 hoàn chỉnh (1080x1920 30fps).
    Toàn bộ các chunk và file render được xử lý trong vùng nhớ tạm tự hủy,
    trả về luồng file nhị phân (MP4 nếu render lẻ, ZIP nếu render cả lô) mà không lưu rác trên đĩa.
    """
    if not req.videos or len(req.videos) == 0:
        raise HTTPException(status_code=400, detail="Không có video nào trong danh sách render.")

    with WORKER_SEMAPHORE:
        import subprocess
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

        session_id = req.session_id or "render"

        with tempfile.TemporaryDirectory() as batch_dir:
            rendered_files = []

            for idx, v_item in enumerate(req.videos):
                safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", v_item.name).strip("_") or f"video_{idx+1}"
                final_mp4_name = f"{safe_name}.mp4"
                final_mp4_path = os.path.join(batch_dir, final_mp4_name)

                with tempfile.TemporaryDirectory() as chunk_dir:
                    chunk_files: List[str] = []
                    total_duration = 0.0

                    for s_idx, slot in enumerate(v_item.slots):
                        resolved_src = resolve_disk_path(slot.file_path, slot.url)
                        if not resolved_src:
                            raise HTTPException(
                                status_code=404,
                                detail=f"Không tìm thấy file nguồn cho cảnh {slot.category.upper()} của video {v_item.name}"
                            )

                        v_begin = max(0.0, slot.video_begin)
                        v_end = slot.video_end
                        if v_end <= v_begin:
                            dur_probe = subprocess.run([ffmpeg_exe, "-i", resolved_src], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                            match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", dur_probe.stderr)
                            if match:
                                h, m, s = match.groups()
                                v_end = int(h) * 3600 + int(m) * 60 + float(s)
                            else:
                                v_end = v_begin + 4.0

                        raw_clip_len = max(0.2, v_end - v_begin)
                        speed = max(0.1, min(5.0, slot.speed or 1.0))
                        display_dur = raw_clip_len / speed
                        total_duration += display_dur

                        vf_filters = []
                        if abs(speed - 1.0) > 0.01:
                            vf_filters.append(f"setpts={1.0 / speed:.4f}*PTS")
                        if slot.flip_h:
                            vf_filters.append("hflip")
                        vf_filters.append("scale=1080:1920:force_original_aspect_ratio=decrease")
                        vf_filters.append("pad=1080:1920:(ow-iw)/2:(oh-ih)/2")
                        vf_filters.append("setsar=1")
                        vf_filters.append("fps=30")

                        chunk_file = os.path.join(chunk_dir, f"slot_{s_idx}_{slot.category}.mp4")

                        cmd_chunk = [
                            ffmpeg_exe, "-y",
                            "-ss", f"{v_begin:.3f}",
                            "-to", f"{v_end:.3f}",
                            "-i", resolved_src,
                            "-vf", ",".join(vf_filters),
                            "-an",
                            "-c:v", "libx264",
                            "-preset", "veryfast",
                            "-crf", "20",
                            chunk_file
                        ]

                        try:
                            subprocess.run(cmd_chunk, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
                            chunk_files.append(chunk_file)
                        except subprocess.CalledProcessError as e:
                            err_msg = e.stderr.decode("utf-8", errors="ignore")
                            raise HTTPException(status_code=500, detail=f"Lỗi khi xử lý cảnh {slot.category}: {err_msg[:300]}")

                    concat_list = os.path.join(chunk_dir, "concat.txt")
                    with open(concat_list, "w") as f:
                        for c in chunk_files:
                            f.write(f"file '{c}'\n")

                    no_audio_concat = os.path.join(chunk_dir, "concat_no_audio.mp4")
                    cmd_concat = [
                        ffmpeg_exe, "-y",
                        "-f", "concat",
                        "-safe", "0",
                        "-i", concat_list,
                        "-c", "copy",
                        no_audio_concat
                    ]
                    subprocess.run(cmd_concat, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

                    voice_path = resolve_disk_path(v_item.voice_file_path, v_item.voice_url)
                    if voice_path:
                        cmd_final = [
                            ffmpeg_exe, "-y",
                            "-i", no_audio_concat,
                            "-i", voice_path,
                            "-map", "0:v",
                            "-map", "1:a",
                            "-c:v", "copy",
                            "-c:a", "aac",
                            "-t", f"{total_duration:.3f}",
                            "-movflags", "+faststart",
                            final_mp4_path
                        ]
                    else:
                        cmd_final = [
                            ffmpeg_exe, "-y",
                            "-i", no_audio_concat,
                            "-f", "lavfi",
                            "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                            "-c:v", "copy",
                            "-c:a", "aac",
                            "-shortest",
                            "-movflags", "+faststart",
                            final_mp4_path
                        ]

                    try:
                        subprocess.run(cmd_final, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
                        rendered_files.append((final_mp4_path, final_mp4_name))
                    except subprocess.CalledProcessError as e:
                        err_msg = e.stderr.decode("utf-8", errors="ignore")
                        raise HTTPException(status_code=500, detail=f"Lỗi khi ghép audio cho {v_item.name}: {err_msg[:300]}")

            # If single video requested, return direct MP4
            if len(rendered_files) == 1 and len(req.videos) == 1:
                with open(rendered_files[0][0], "rb") as f:
                    mp4_bytes = f.read()
                return Response(
                    content=mp4_bytes,
                    media_type="video/mp4",
                    headers={
                        "Content-Disposition": f'attachment; filename="{rendered_files[0][1]}"',
                    },
                )

            # If batch, package into in-memory ZIP
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zipf:
                for file_path, file_name in rendered_files:
                    zipf.write(file_path, arcname=file_name)

            zip_buffer.seek(0)
            return Response(
                content=zip_buffer.getvalue(),
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="lachvid_rendered_{session_id}.zip"',
                    "X-Total-Rendered": str(len(rendered_files)),
                },
            )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
