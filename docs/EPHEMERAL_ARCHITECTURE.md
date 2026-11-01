# Ephemeral Stateless Processing Architecture (Option A)

This document provides a comprehensive architectural guide for future developers and AI agents working on **LachVid Studio**.

---

## 1. Architectural Overview & Design Philosophy

Prior to this implementation, LachVid Studio persisted all uploaded video files, cut segments, and project states into a single local directory (`data/`) and shared a single state file (`data/project_state.json`). This created two critical limitations for production:
1. **Multi-tenant Collision**: Concurrent users overwrote each other's state and files.
2. **Disk Accumulation**: Sliced `.mp4` chunks and render outputs permanently accumulated on disk unless manually purged.

**Option A (Stateless Ephemeral Pipeline)** solves both challenges without requiring external Cloud Object Storage (e.g., Cloudflare R2 / AWS S3) for temporary editing workflows:

- **Client-Side Preview (0ms Latency)**: When users pick a video or clips, the browser instantiates an in-memory `Blob URL` (`URL.createObjectURL(file)`). Seeking, trimming by `0.1s`, horizontal flipping (`scaleX(-1)`), and speed playback adjustments run in real time on the client with zero network lag.
- **Strict Single Original Video Rule**: In Step 1 (Scene Splitting), exactly **one** master video is stored per user session in `/tmp/lachvid_sessions/{session_id}/source/`. Uploading a new video or clicking *"Tách video tiếp theo"* instantly removes previous master video files.
- **Ephemeral Slicing & Rendering**: When exporting sliced clips or composing final videos, Python FFmpeg cuts and renders directly inside ephemeral temporary directories (`tempfile.TemporaryDirectory()`). The resulting `.mp4` / `.zip` streams back to the browser and the temporary directory immediately self-destructs (0 residual cut bytes on disk).
- **In-Browser ZIP Unpacking for Direct Folder Saving**: When the user chooses *"Lưu thẳng vào thư mục máy tính"* via the File System Access API (`showDirectoryPicker`), the browser receives the `.zip` binary stream, extracts files in memory using `JSZip`, and writes them directly into the selected local disk folders (`OPEN`, `PRODUCT`, `TEXTURE`, `APPLY`, `END`).

---

## 2. Session Isolation & Lifecycle Management

### 2.1 Directory Structure
Each browser tab or user instance generates a unique session identifier (`sess_<timestamp>_<random>`) stored in `localStorage` and passed via the `x-session-id` HTTP header or body parameter:

```
<os.tmpdir>/lachvid_sessions/
└── sess_xxxxxx/
    ├── source/
    │   └── <timestamp>_master_video.mp4   # EXACTLY ONE master video
    ├── categories/
    │   ├── open/
    │   ├── product/
    │   ├── texture/
    │   ├── apply/
    │   └── end/
    ├── voices/
    │   └── voice_xxxx.mp3
    └── project_state.json                 # Isolated state per user
```

### 2.2 Background Cleanup Janitor (TTL & Quota Eviction)
Both the Next.js API layer ([`src/lib/store.ts`](file:///Users/trevor/Documents/Personal/lachvid/src/lib/store.ts)) and the Python FastAPI worker ([`backend/main.py`](file:///Users/trevor/Documents/Personal/lachvid/backend/main.py)) enforce strict eviction rules:
1. **30-Minute Inactivity TTL**: Any session directory whose last modified time (`mtime`) exceeds 30 minutes without active requests is automatically wiped with `rmtree`.
2. **5 GB Global Quota Cap (LRU)**: If the total size of all active sessions in `lachvid_sessions/` exceeds 5 GB, the oldest sessions (least recently active) are purged until usage falls below the threshold.
3. **On-Demand Reset**: Clicking *"Tách video tiếp theo"* invokes `POST /api/project` with `{ action: "reset_source" }`, purging the master video from disk immediately.

---

## 3. Concurrency Control (Semaphore)

To guarantee high stability when 10+ users interact simultaneously:
- In [`backend/main.py`](file:///Users/trevor/Documents/Personal/lachvid/backend/main.py), a bounded concurrency gate (`WORKER_SEMAPHORE = threading.BoundedSemaphore(3)`) guards CPU-heavy workloads:
  - `PySceneDetect` frame analysis (`/detect-local`, `/detect-upload`)
  - `FFmpeg` batch slicing (`/slice-scenes`)
  - `FFmpeg` composed video rendering (`/render-composed`)
- If 10 requests arrive simultaneously, 3 run in parallel while 7 wait smoothly in a fast queue, preventing CPU spikes and Out-Of-Memory (OOM) crashes.

---

## 4. Key Endpoints Reference

| Route | Method | Purpose | Ephemeral Behavior |
| :--- | :--- | :--- | :--- |
| `/api/upload-local` | `POST` | Upload source video or voice track | Purges any existing master video in `source/` before saving the new one. |
| `/api/project` | `GET` / `POST` | Read/write isolated project state | Returns isolated state per `sessionId`. Handles reset actions. |
| `/api/detect-scenes` | `POST` | PySceneDetect scene detection | Reads master video from `source/`, returns detected timestamps JSON. |
| `/api/slice-scenes` | `POST` | Slice and package 5 category folders | Python FFmpeg cuts inside self-destructing `tempfile.TemporaryDirectory()`, returns ZIP stream directly. Zero files saved. |
| `/api/category-library` | `GET` / `POST` | Manage Step 2 category pool | Saves category video clips & voice files inside session-isolated folders. Deletes physical files when items are removed. |
| `/api/plan-mix` | `POST` | Combinatorial generation & diversity | Generates unique 5-category combinations per session. |
| `/api/render-composed` | `POST` | Render single or batch MP4s | Renders inside ephemeral temp directory, streams single MP4 or multi-file ZIP. Zero files saved. |
| `/api/media/[...path]` | `GET` | Stream media with HTTP Range (206) | Resolves `/api/media/sessions/{sessionId}/...` with `Range` header support for smooth seeking. |

---

## 5. Verification & Testing

- **TypeScript Typecheck**: `npx tsc --noEmit` exits cleanly with 0 errors.
- **ESLint**: `npm run lint` passes without any React hook or cascading render errors.
- **Production Next.js Build**: `npm run build` compiles all dynamic and static routes cleanly.
- **Python Syntax**: Validated with `py_compile` on `backend/main.py`.
