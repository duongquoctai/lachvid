import io
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.request
import urllib.parse
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

# Concurrency Semaphore & FFmpeg Thread Count (configurable via env vars)
try:
    _env_workers = int(os.getenv("WORKER_CONCURRENCY", "1"))
except ValueError:
    _env_workers = 1
WORKER_SEMAPHORE = threading.BoundedSemaphore(max(1, _env_workers))

try:
    _env_ffmpeg_threads = max(1, int(os.getenv("FFMPEG_THREADS", "2")))
except ValueError:
    _env_ffmpeg_threads = 2
FFMPEG_THREADS = str(_env_ffmpeg_threads)

# Real-time render progress tracker: session_id -> { current, total, percent, current_name }
RENDER_PROGRESS = {}

@app.get("/render-progress/{session_id}")
async def get_render_progress(session_id: str):
    progress = RENDER_PROGRESS.get(session_id)
    if not progress:
        return {"active": False, "current": 0, "total": 0, "percent": 0, "current_name": ""}
    return {
        "active": True,
        "current": progress.get("current", 0),
        "total": progress.get("total", 0),
        "percent": progress.get("percent", 0),
        "current_name": progress.get("current_name", ""),
    }

# -------------------------------------------------------------
# BACKGROUND CLEANUP JANITOR (TTL 30 mins, Configurable Max MB)
# -------------------------------------------------------------
SESSION_TTL_SECONDS = 30 * 60  # 30 minutes
try:
    _env_max_mb = int(os.getenv("MAX_STORAGE_MB", "600"))
except ValueError:
    _env_max_mb = 600
MAX_STORAGE_BYTES = (_env_max_mb if _env_max_mb > 0 else 600) * 1024 * 1024


class StreamingZipBuffer:
    """Non-seekable stream buffer for zipfile.ZipFile that flushes bytes after each entry."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0

    def write(self, data: bytes | bytearray | memoryview) -> int:
        n = len(data)
        self._buf.extend(data)
        self._pos += n
        return n

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def seekable(self) -> bool:
        return False

    def pop_bytes(self) -> bytes:
        data = bytes(self._buf)
        self._buf.clear()
        return data

def get_base_sessions_dir() -> str:
    return os.path.join(tempfile.gettempdir(), "lachvid_sessions")

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
    Cắt video thành các file .mp4 riêng biệt và stream ZIP trực tiếp (cuốn chiếu).
    Xóa ngay từng cảnh cắt sau khi đưa vào luồng ZIP để không chiếm RAM và ổ cứng.
    """
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail=f"File nguồn không tồn tại: {req.file_path}")

    session_id = req.session_id or "export"

    def _slice_zip_generator():
        import subprocess
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

        probe = subprocess.run([ffmpeg_exe, "-i", req.file_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        has_audio = "Audio:" in probe.stderr

        valid_categories = {"OPEN", "PRODUCT", "TEXTURE", "APPLY", "END"}

        with tempfile.TemporaryDirectory() as ephemeral_dir:
            zip_stream = StreamingZipBuffer()
            with zipfile.ZipFile(zip_stream, "w", zipfile.ZIP_DEFLATED) as zipf:
                for idx, sc in enumerate(req.scenes):
                    with WORKER_SEMAPHORE:
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
                            "-hide_banner",
                            "-loglevel", "error",
                            "-threads", FFMPEG_THREADS,
                            "-y",
                            "-ss", f"{sc.begin:.3f}",
                            "-to", f"{sc.end:.3f}",
                            "-i", req.file_path,
                            "-filter_threads", FFMPEG_THREADS,
                            "-filter_complex_threads", FFMPEG_THREADS,
                        ]

                        if vf_filters:
                            cmd.extend(["-vf", ",".join(vf_filters)])

                        if audio_filters:
                            cmd.extend(["-af", ",".join(audio_filters)])

                        cmd.extend([
                            "-c:v", "libx264",
                            "-preset", "superfast",
                            "-crf", "19",
                            "-threads", FFMPEG_THREADS,
                            "-x264-params", f"threads={FFMPEG_THREADS}:rc-lookahead=5:sync-lookahead=0:ref=1:bframes=0",
                            "-c:a", "aac",
                            "-movflags", "+faststart",
                            out_file_path,
                        ])

                        try:
                            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
                            arc_name = f"{cat_upper}/{file_name}"
                            zipf.write(out_file_path, arcname=arc_name)
                        except subprocess.CalledProcessError as e:
                            err_msg = e.stderr.decode("utf-8", errors="ignore").strip()
                            sig_hint = f" (killed signal {e.returncode} - OOM)" if e.returncode < 0 else f" (exit {e.returncode})"
                            raise HTTPException(status_code=500, detail=f"Lỗi khi cắt cảnh {file_name}{sig_hint}: {err_msg[-400:]}")
                        finally:
                            if os.path.exists(out_file_path):
                                try:
                                    os.remove(out_file_path)
                                except OSError:
                                    pass

                        chunk_bytes = zip_stream.pop_bytes()

                    if chunk_bytes:
                        yield chunk_bytes

            tail_bytes = zip_stream.pop_bytes()
            if tail_bytes:
                yield tail_bytes

    gen = _slice_zip_generator()
    first_chunk = next(gen, b"")

    def _chained_stream():
        if first_chunk:
            yield first_chunk
        yield from gen

    return StreamingResponse(
        _chained_stream(),
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

def extract_drive_file_id(url: str) -> Optional[str]:
    if not url:
        return None
    m = re.search(r"/api/drive-stream/([a-zA-Z0-9_-]{20,})", url)
    if m:
        return m.group(1)
    m = re.search(r"/file/d/([a-zA-Z0-9_-]{20,})", url)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]{20,})", url)
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{25,50}$", url.strip()):
        return url.strip()
    return None

def download_drive_file(file_id: str, dest_path: str) -> bool:
    direct_url = f"https://drive.google.com/uc?export=download&id={file_id}"
    req = urllib.request.Request(
        direct_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content_type = resp.headers.get("Content-Type", "").lower()
            if "text/html" in content_type:
                return False
            with open(dest_path, "wb") as f:
                shutil.copyfileobj(resp, f)
        return os.path.exists(dest_path) and os.path.getsize(dest_path) > 1000
    except Exception:
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass
        return False

def resolve_disk_path(
    file_path: Optional[str],
    url: Optional[str],
    drive_cache_dir: Optional[str] = None
) -> Optional[str]:
    """Tìm đường dẫn thực tế trên đĩa từ file_path hoặc url (tải tạm từ Google Drive vào cache tự hủy nếu cần)."""
    if file_path and os.path.exists(file_path):
        return os.path.abspath(file_path)
    if url:
        clean = url.split("?")[0].strip()

        # Check if Google Drive file
        drive_id = extract_drive_file_id(url)
        if drive_id and drive_cache_dir:
            cached_file = os.path.join(drive_cache_dir, f"drive_{drive_id}.media")
            cached_file_old = os.path.join(drive_cache_dir, f"drive_{drive_id}.mp4")
            if os.path.exists(cached_file) and os.path.getsize(cached_file) > 1000:
                return cached_file
            if os.path.exists(cached_file_old) and os.path.getsize(cached_file_old) > 1000:
                return cached_file_old
            if download_drive_file(drive_id, cached_file):
                return cached_file

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
    Stream trực tiếp từng video vào luồng ZIP (không lưu dồn trong RAM hay trên đĩa)
    và tự động xóa cuốn chiếu các file chunk/drive cache ngay khi hết lượt sử dụng.
    """
    if not req.videos or len(req.videos) == 0:
        raise HTTPException(status_code=400, detail="Không có video nào trong danh sách render.")

    session_id = req.session_id or "render"
    is_single = len(req.videos) == 1

    # Single video mode: render inside semaphore, then stream MP4 in 256KB chunks outside semaphore
    if is_single:
        def _single_mp4_generator():
            import subprocess
            import hashlib
            from concurrent.futures import ThreadPoolExecutor
            import imageio_ffmpeg
            ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

            v_item = req.videos[0]
            safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", v_item.name).strip("_") or "video_1"
            final_mp4_name = f"{safe_name}.mp4"

            with tempfile.TemporaryDirectory() as batch_dir:
                drive_cache_dir = os.path.join(batch_dir, "_drive_cache")
                chunk_cache_dir = os.path.join(batch_dir, "_chunk_cache")
                os.makedirs(drive_cache_dir, exist_ok=True)
                os.makedirs(chunk_cache_dir, exist_ok=True)
                final_mp4_path = os.path.join(batch_dir, final_mp4_name)

                with WORKER_SEMAPHORE:
                    unique_drive_ids = set()
                    if v_item.voice_url:
                        did = extract_drive_file_id(v_item.voice_url)
                        if did:
                            unique_drive_ids.add(did)
                    for slot in v_item.slots:
                        if slot.url:
                            did = extract_drive_file_id(slot.url)
                            if did:
                                unique_drive_ids.add(did)

                    if unique_drive_ids:
                        def _prefetch_single_drive(fid: str):
                            target = os.path.join(drive_cache_dir, f"drive_{fid}.media")
                            if not (os.path.exists(target) and os.path.getsize(target) > 1000):
                                download_drive_file(fid, target)

                        with ThreadPoolExecutor(max_workers=min(6, len(unique_drive_ids))) as pool:
                            list(pool.map(_prefetch_single_drive, unique_drive_ids))

                    chunk_files: List[str] = []
                    total_duration = 0.0

                    for s_idx, slot in enumerate(v_item.slots):
                        resolved_src = resolve_disk_path(slot.file_path, slot.url, drive_cache_dir=drive_cache_dir)
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

                        chunk_sig = f"{resolved_src}|{v_begin:.3f}|{v_end:.3f}|{speed:.4f}|{int(bool(slot.flip_h))}"
                        chunk_hash = hashlib.md5(chunk_sig.encode("utf-8")).hexdigest()[:16]
                        cached_chunk_path = os.path.join(chunk_cache_dir, f"chunk_{chunk_hash}_{s_idx}.mp4")

                        vf_filters = []
                        if abs(speed - 1.0) > 0.01:
                            vf_filters.append(f"setpts={1.0 / speed:.4f}*PTS")
                        if slot.flip_h:
                            vf_filters.append("hflip")
                        vf_filters.append("scale=1080:1920:force_original_aspect_ratio=decrease")
                        vf_filters.append("pad=1080:1920:(ow-iw)/2:(oh-ih)/2")
                        vf_filters.append("setsar=1")
                        vf_filters.append("fps=30")

                        cmd_chunk = [
                            ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-y",
                            "-ss", f"{v_begin:.3f}",
                            "-to", f"{v_end:.3f}",
                            "-threads", FFMPEG_THREADS,
                            "-i", resolved_src,
                            "-filter_threads", FFMPEG_THREADS, "-filter_complex_threads", FFMPEG_THREADS,
                            "-vf", ",".join(vf_filters),
                            "-an",
                            "-c:v", "libx264",
                            "-preset", "superfast",
                            "-crf", "23",
                            "-maxrate", "4M",
                            "-bufsize", "4M",
                            "-pix_fmt", "yuv420p",
                            "-threads", FFMPEG_THREADS,
                            "-x264-params", f"threads={FFMPEG_THREADS}:rc-lookahead=5:sync-lookahead=0:ref=1:bframes=0",
                            cached_chunk_path,
                        ]
                        try:
                            subprocess.run(cmd_chunk, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
                            chunk_files.append(cached_chunk_path)
                        except subprocess.CalledProcessError as e:
                            err_msg = e.stderr.decode("utf-8", errors="ignore").strip()
                            sig_hint = f" (killed signal {e.returncode} - OOM)" if e.returncode < 0 else f" (exit {e.returncode})"
                            raise HTTPException(status_code=500, detail=f"Lỗi khi xử lý cảnh {slot.category}{sig_hint}: {err_msg[-400:]}")

                    concat_list = os.path.join(batch_dir, "concat.txt")
                    with open(concat_list, "w") as f:
                        for c in chunk_files:
                            f.write(f"file '{c}'\n")

                    voice_path = resolve_disk_path(
                        v_item.voice_file_path,
                        v_item.voice_url,
                        drive_cache_dir=drive_cache_dir,
                    )

                    if voice_path:
                        cmd_final = [
                            ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "concat",
                            "-safe", "0",
                            "-i", concat_list,
                            "-i", voice_path,
                            "-filter_complex", "[1:a]apad[aout]",
                            "-map", "0:v",
                            "-map", "[aout]",
                            "-c:v", "copy",
                            "-c:a", "aac",
                            "-t", f"{total_duration:.3f}",
                            "-movflags", "+faststart",
                            final_mp4_path,
                        ]
                    else:
                        cmd_final = [
                            ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "concat",
                            "-safe", "0",
                            "-i", concat_list,
                            "-f", "lavfi",
                            "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                            "-map", "0:v",
                            "-map", "1:a",
                            "-c:v", "copy",
                            "-c:a", "aac",
                            "-t", f"{total_duration:.3f}",
                            "-shortest",
                            "-movflags", "+faststart",
                            final_mp4_path,
                        ]

                    try:
                        subprocess.run(cmd_final, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
                    except subprocess.CalledProcessError as e:
                        err_msg = e.stderr.decode("utf-8", errors="ignore").strip()
                        sig_hint = f" (killed signal {e.returncode} - OOM)" if e.returncode < 0 else f" (exit {e.returncode})"
                        raise HTTPException(status_code=500, detail=f"Lỗi khi ghép audio cho {v_item.name}{sig_hint}: {err_msg[-400:]}")

                    shutil.rmtree(chunk_cache_dir, ignore_errors=True)
                    shutil.rmtree(drive_cache_dir, ignore_errors=True)

                # Stream outside WORKER_SEMAPHORE so semaphore is never held across yield
                with open(final_mp4_path, "rb") as f:
                    while True:
                        buf = f.read(256 * 1024)
                        if not buf:
                            break
                        yield buf

        gen = _single_mp4_generator()
        first_chunk = next(gen, b"")

        def _chained_single():
            if first_chunk:
                yield first_chunk
            yield from gen

        v0_safe = re.sub(r"[^a-zA-Z0-9_-]", "_", req.videos[0].name).strip("_") or "video_1"
        return StreamingResponse(
            _chained_single(),
            media_type="video/mp4",
            headers={
                "Content-Disposition": f'attachment; filename="{v0_safe}.mp4"',
            },
        )

    # Batch mode: Stream ZIP on the fly + rolling eviction of chunks & drive files
    def _batch_zip_generator():
        import subprocess
        import hashlib
        from concurrent.futures import ThreadPoolExecutor
        import imageio_ffmpeg
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

        RENDER_PROGRESS[session_id] = {
            "current": 0,
            "total": len(req.videos),
            "current_name": "",
            "percent": 0,
        }

        try:
            with tempfile.TemporaryDirectory() as batch_dir:
                drive_cache_dir = os.path.join(batch_dir, "_drive_cache")
                chunk_cache_dir = os.path.join(batch_dir, "_chunk_cache")
                os.makedirs(drive_cache_dir, exist_ok=True)
                os.makedirs(chunk_cache_dir, exist_ok=True)

                # Track last video index that uses each Drive file ID and each slot signature
                drive_last_video_idx = {}
                slot_last_video_idx = {}
                unique_drive_ids = set()

                for v_idx, v_item in enumerate(req.videos):
                    if v_item.voice_url:
                        did = extract_drive_file_id(v_item.voice_url)
                        if did:
                            unique_drive_ids.add(did)
                            drive_last_video_idx[did] = v_idx
                    for slot in v_item.slots:
                        if slot.url:
                            did = extract_drive_file_id(slot.url)
                            if did:
                                unique_drive_ids.add(did)
                                drive_last_video_idx[did] = v_idx
                        slot_key = (
                            slot.file_path or "",
                            slot.url or "",
                            round(max(0.0, slot.video_begin), 3),
                            round(slot.video_end, 3),
                            round(max(0.1, min(5.0, slot.speed or 1.0)), 4),
                            bool(slot.flip_h),
                        )
                        slot_last_video_idx[slot_key] = v_idx

                if unique_drive_ids:
                    def _prefetch_drive(fid: str):
                        target = os.path.join(drive_cache_dir, f"drive_{fid}.media")
                        if not (os.path.exists(target) and os.path.getsize(target) > 1000):
                            download_drive_file(fid, target)

                    with ThreadPoolExecutor(max_workers=min(8, len(unique_drive_ids))) as pool:
                        list(pool.map(_prefetch_drive, unique_drive_ids))

                zip_stream = StreamingZipBuffer()
                rendered_count = 0
                chunk_dur_cache = {}
                probe_dur_cache = {}

                with zipfile.ZipFile(zip_stream, "w", zipfile.ZIP_STORED) as zipf:
                    for idx, v_item in enumerate(req.videos):
                        with WORKER_SEMAPHORE:
                            safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", v_item.name).strip("_") or f"video_{idx+1}"
                            final_mp4_name = f"{safe_name}.mp4"
                            final_mp4_path = os.path.join(batch_dir, final_mp4_name)
                            retire_chunk_paths = set()

                            with tempfile.TemporaryDirectory() as chunk_dir:
                                chunk_files: List[str] = []
                                total_duration = 0.0

                                for s_idx, slot in enumerate(v_item.slots):
                                    resolved_src = resolve_disk_path(slot.file_path, slot.url, drive_cache_dir=drive_cache_dir)
                                    if not resolved_src:
                                        raise HTTPException(
                                            status_code=404,
                                            detail=f"Không tìm thấy file nguồn cho cảnh {slot.category.upper()} của video {v_item.name}"
                                        )

                                    slot_key = (
                                        slot.file_path or "",
                                        slot.url or "",
                                        round(max(0.0, slot.video_begin), 3),
                                        round(slot.video_end, 3),
                                        round(max(0.1, min(5.0, slot.speed or 1.0)), 4),
                                        bool(slot.flip_h),
                                    )

                                    v_begin = max(0.0, slot.video_begin)
                                    v_end = slot.video_end
                                    if v_end <= v_begin:
                                        if resolved_src in probe_dur_cache:
                                            v_end = probe_dur_cache[resolved_src]
                                        else:
                                            dur_probe = subprocess.run([ffmpeg_exe, "-i", resolved_src], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                                            match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", dur_probe.stderr)
                                            if match:
                                                h, m, s = match.groups()
                                                v_end = int(h) * 3600 + int(m) * 60 + float(s)
                                            else:
                                                v_end = v_begin + 4.0
                                            probe_dur_cache[resolved_src] = v_end

                                    raw_clip_len = max(0.2, v_end - v_begin)
                                    speed = max(0.1, min(5.0, slot.speed or 1.0))
                                    display_dur = raw_clip_len / speed

                                    chunk_sig = f"{resolved_src}|{v_begin:.3f}|{v_end:.3f}|{speed:.4f}|{int(bool(slot.flip_h))}"
                                    chunk_hash = hashlib.md5(chunk_sig.encode("utf-8")).hexdigest()[:16]
                                    cached_chunk_path = os.path.join(chunk_cache_dir, f"chunk_{chunk_hash}.mp4")

                                    if slot_last_video_idx.get(slot_key, idx) <= idx:
                                        retire_chunk_paths.add(cached_chunk_path)

                                    if os.path.exists(cached_chunk_path) and os.path.getsize(cached_chunk_path) > 1000:
                                        chunk_files.append(cached_chunk_path)
                                        total_duration += chunk_dur_cache.get(chunk_hash, display_dur)
                                        continue

                                    total_duration += display_dur
                                    chunk_dur_cache[chunk_hash] = display_dur

                                    vf_filters = []
                                    if abs(speed - 1.0) > 0.01:
                                        vf_filters.append(f"setpts={1.0 / speed:.4f}*PTS")
                                    if slot.flip_h:
                                        vf_filters.append("hflip")
                                    vf_filters.append("scale=1080:1920:force_original_aspect_ratio=decrease")
                                    vf_filters.append("pad=1080:1920:(ow-iw)/2:(oh-ih)/2")
                                    vf_filters.append("setsar=1")
                                    vf_filters.append("fps=30")

                                    cmd_chunk = [
                                        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-y",
                                        "-ss", f"{v_begin:.3f}",
                                        "-to", f"{v_end:.3f}",
                                        "-threads", FFMPEG_THREADS,
                                        "-i", resolved_src,
                                        "-filter_threads", FFMPEG_THREADS, "-filter_complex_threads", FFMPEG_THREADS,
                                        "-vf", ",".join(vf_filters),
                                        "-an",
                                        "-c:v", "libx264",
                                        "-preset", "superfast",
                                        "-crf", "23",
                                        "-maxrate", "4M",
                                        "-bufsize", "4M",
                                        "-pix_fmt", "yuv420p",
                                        "-threads", FFMPEG_THREADS,
                                        "-x264-params", f"threads={FFMPEG_THREADS}:rc-lookahead=5:sync-lookahead=0:ref=1:bframes=0",
                                        cached_chunk_path
                                    ]

                                    try:
                                        subprocess.run(cmd_chunk, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
                                        chunk_files.append(cached_chunk_path)
                                    except subprocess.CalledProcessError as e:
                                        err_msg = e.stderr.decode("utf-8", errors="ignore").strip()
                                        sig_hint = f" (killed signal {e.returncode} - OOM)" if e.returncode < 0 else f" (exit {e.returncode})"
                                        raise HTTPException(status_code=500, detail=f"Lỗi khi xử lý cảnh {slot.category}{sig_hint}: {err_msg[-400:]}")

                                concat_list = os.path.join(chunk_dir, "concat.txt")
                                with open(concat_list, "w") as f:
                                    for c in chunk_files:
                                        f.write(f"file '{c}'\n")

                                voice_path = resolve_disk_path(
                                    v_item.voice_file_path,
                                    v_item.voice_url,
                                    drive_cache_dir=drive_cache_dir,
                                )

                                if voice_path:
                                    cmd_final = [
                                        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-y",
                                        "-f", "concat",
                                        "-safe", "0",
                                        "-i", concat_list,
                                        "-i", voice_path,
                                        "-filter_complex", "[1:a]apad[aout]",
                                        "-map", "0:v",
                                        "-map", "[aout]",
                                        "-c:v", "copy",
                                        "-c:a", "aac",
                                        "-t", f"{total_duration:.3f}",
                                        "-movflags", "+faststart",
                                        final_mp4_path
                                    ]
                                else:
                                    cmd_final = [
                                        ffmpeg_exe, "-hide_banner", "-loglevel", "error", "-y",
                                        "-f", "concat",
                                        "-safe", "0",
                                        "-i", concat_list,
                                        "-f", "lavfi",
                                        "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                                        "-map", "0:v",
                                        "-map", "1:a",
                                        "-c:v", "copy",
                                        "-c:a", "aac",
                                        "-t", f"{total_duration:.3f}",
                                        "-shortest",
                                        "-movflags", "+faststart",
                                        final_mp4_path
                                    ]

                                try:
                                    subprocess.run(cmd_final, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
                                except subprocess.CalledProcessError as e:
                                    err_msg = e.stderr.decode("utf-8", errors="ignore").strip()
                                    sig_hint = f" (killed signal {e.returncode} - OOM)" if e.returncode < 0 else f" (exit {e.returncode})"
                                    raise HTTPException(status_code=500, detail=f"Lỗi khi ghép audio cho {v_item.name}{sig_hint}: {err_msg[-400:]}")

                                # Rolling cleanup: remove any chunk and Drive cached file no longer needed by remaining videos
                                for cpath in retire_chunk_paths:
                                    if os.path.exists(cpath):
                                        try:
                                            os.remove(cpath)
                                        except OSError:
                                            pass
                                for did, last_idx in list(drive_last_video_idx.items()):
                                    if last_idx <= idx:
                                        dfile = os.path.join(drive_cache_dir, f"drive_{did}.media")
                                        if os.path.exists(dfile):
                                            try:
                                                os.remove(dfile)
                                            except OSError:
                                                pass
                                        drive_last_video_idx.pop(did, None)

                            # Write rendered MP4 into non-seekable ZIP stream and immediately delete MP4 from disk
                            zipf.write(final_mp4_path, arcname=final_mp4_name)
                            try:
                                os.remove(final_mp4_path)
                            except OSError:
                                pass

                            rendered_count += 1
                            RENDER_PROGRESS[session_id] = {
                                "current": rendered_count,
                                "total": len(req.videos),
                                "percent": round((rendered_count / len(req.videos)) * 100),
                                "current_name": v_item.name,
                            }

                            chunk_bytes = zip_stream.pop_bytes()

                        # Yield outside WORKER_SEMAPHORE so semaphore is never held while waiting on network I/O
                        if chunk_bytes:
                            yield chunk_bytes

                tail_bytes = zip_stream.pop_bytes()
                if tail_bytes:
                    yield tail_bytes
        finally:
            RENDER_PROGRESS.pop(session_id, None)

    gen = _batch_zip_generator()
    first_chunk = next(gen, b"")

    def _chained_batch():
        if first_chunk:
            yield first_chunk
        yield from gen

    return StreamingResponse(
        _chained_batch(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="lachvid_rendered_{session_id}.zip"',
            "X-Total-Rendered": str(len(req.videos)),
        },
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3006, reload=True)
