# Quy định & Hướng dẫn dành cho AI Agents (AGENTS.md)

Tài liệu này ghi chú các quy chuẩn bắt buộc mà toàn bộ AI Agents / Developers phải tuân thủ nghiêm ngặt khi phát triển, chỉnh sửa và tạo mới code trong dự án **Lachvid Studio**.

---

## 1. Quy tắc viết hoa tiêu đề & UI Text (Title & Header Capitalization)

> [!IMPORTANT]
> **Tuyệt đối KHÔNG viết hoa từng chữ theo kiểu Capital Case (Title Case) trong tiếng Việt.**
> Toàn bộ UI (tiêu đề, heading, nhãn nút, thẻ card, modal, tooltip, thông báo trạng thái) phải sử dụng **Sentence case**.

### Chi tiết quy tắc:
1. **Sentence case (Chữ cái đầu câu hoa, còn lại viết thường)**:
   - Chỉ viết hoa chữ cái đầu tiên của cụm từ/tiêu đề hoặc chữ cái đầu tiên ngay sau dấu hai chấm `:`.
   - Nếu có mở ngoặc giải thích ở cuối tiêu đề, chỉ viết hoa chữ cái đầu trong ngoặc nếu cần (hoặc viết thường theo ngữ cảnh), không viết hoa toàn bộ từng chữ trong ngoặc.
   - Các từ tiếng Việt thông thường ở giữa câu/tiêu đề **bắt buộc viết thường**.
2. **Ngoại lệ được phép giữ nguyên**:
   - Tên thương hiệu riêng: `Zvid`, `TikTok`, `Lachvid`, `Google`, v.v.
   - Thuật ngữ / định dạng / từ viết tắt kỹ thuật: `API`, `MP4`, `MP3`, `ZIP`, `JSON`, `FFmpeg`, `CDN`, `URL`, `ID`, v.v.
   - Tên người / hiệu ứng mang tên riêng: `Ken Burns`.

### Bảng ví dụ đối chiếu chuẩn:

| ❌ Không sử dụng (Title Case) | ✅ Bắt buộc sử dụng (Sentence case) |
| :--- | :--- |
| `Danh Sách 6 Cảnh Cắt (Chỉnh Mốc Giây Từng 0.1s)` | `Danh sách 6 cảnh cắt (Chỉnh mốc giây từng 0.1s)` |
| `Cài Đặt Số Giây Tối Thiểu (Min Giây) Cho 5 Category` | `Cài đặt số giây tối thiểu (min giây) cho 5 category` |
| `Upload 1 Video Gốc Để Tách` | `Upload 1 video gốc để tách` |
| `Thống Kê 5 Nhóm Cảnh Cắt:` | `Thống kê 5 nhóm cảnh cắt:` |
| `Màn Hình Duyệt Cảnh (Source Video Monitor)` | `Màn hình duyệt cảnh (Source video monitor)` |
| `Chỉnh Sửa Riêng Cho Cảnh Đang Chọn:` | `Chỉnh sửa riêng cho cảnh đang chọn:` |
| `Kho Video Theo 5 Category (Đã Tách Từ Máy Tính)` | `Kho video theo 5 category (đã tách từ máy tính)` |
| `Chọn Thư Mục Tổng Từ Máy (Tự Phân 5 Cột)` | `Chọn thư mục tổng từ máy (tự phân 5 cột)` |
| `Xuất Toàn Bộ Các Cảnh Đã Tinh Chỉnh Về Máy Tính` | `Xuất toàn bộ các cảnh đã tinh chỉnh về máy tính` |
| `Tải ZIP Toàn Bộ (5 Folder)` | `Tải ZIP toàn bộ (5 folder)` |
| `Lưu Thẳng Vào Thư Mục Máy Tính` | `Lưu thẳng vào thư mục máy tính` |
| `Tách Video Tiếp Theo` | `Tách video tiếp theo` |
| `Thời Lượng & Số Lượng Output` | `Thời lượng & số lượng output` |
| `Lồng Voice (Tùy Chọn)` | `Lồng voice (tùy chọn)` |
| `+ Thêm Voice MP3` | `+ Thêm voice MP3` |
| `Trộn Video (Speed Scale)` | `Trộn video (Speed scale)` |
| `Danh Sách 8 Tổ Hợp Video` | `Danh sách 8 tổ hợp video` |
| `Web Canvas Preview 9:16` | `Web canvas preview 9:16` |
| `Render Hàng Loạt Qua Zvid Paid API Cloud` | `Render hàng loạt qua Zvid paid API cloud` |
| `Kiểm Tra Hạn Mức Zvid` | `Kiểm tra hạn mức Zvid` |
| `Validate (0 Credit)` | `Validate (0 credit)` |
| `Render Cả Lô` / `Render Lẻ` | `Render cả lô` / `Render lẻ` |
| `+ Thêm Shot Thủ Công` / `Thêm Clip` | `+ Thêm shot thủ công` / `Thêm clip` |
| `Khoá Chữ (L)` | `Khoá chữ (L)` |
| `Ken Burns Zoom` | `Ken Burns zoom` |
| `Tạm Dừng` | `Tạm dừng` |
| `Zvid.io Inline RenderPayload` | `Zvid.io inline renderPayload` |

---

## 2. Phạm vi áp dụng trong Source Code
Quy tắc trên áp dụng cho:
- Mọi thẻ Heading JSX: `<h1>`, `<h2>`, `<h3>`, `<h4>`, `<h5>`, `<h6>`
- Tiêu đề modal, tiêu đề section, nhãn tab workspace
- Text trên các Button `<button>` và Link `<a>`
- Tooltip hover qua thuộc tính `title="..."`
- Tiêu đề nhãn input `<label>`
- Text thông báo banner/alert (`statusBanner`, `toast`, thông báo lỗi)

---

## 3. Tech Stack & Cấu hình dự án Lachvid Studio
- **Next.js**: 16.4.3 (Turbopack)
- **React**: 19.3.1 (Hỗ trợ React automatic runtime & React Hooks rule)
- **Font**: GeistSans (`geist/font/sans`) được cấu hình global toàn app
- **Styling**: Tailwind CSS
- **Linting**: ESLint 9 (Flat config `eslint.config.mjs`)

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
