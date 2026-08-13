# SOP Widget

Ứng dụng desktop Windows chạy offline: tạo/chạy SOP theo từng bước, chụp ảnh bằng chứng,
lưu SQLite local, xuất báo cáo HTML. App **không** tự thực thi lệnh hay SSH — lệnh chỉ là
hướng dẫn hiển thị cho người thực hiện.

## Tech Stack
- Language: TypeScript 5.5 (frontend) · Rust edition 2021 (backend)
- Framework: React 18.3 + Vite 5.3 · Tauri 2.0 (desktop shell)
- Database: SQLite local qua `rusqlite 0.32` (feature `bundled` — không cần cài SQLite ngoài)
- Frontend: React 18 + CSS thuần (`src/styles.css`), không dùng UI library / CSS framework
- Infrastructure: bundle NSIS cho Windows (`tauri build`), không Docker, không CI
- Architecture: desktop monolith offline — React SPA → Tauri IPC (`invoke`) → command trong `src-tauri/src/lib.rs` → SQLite
- Thư viện chính khác: `screenshots 0.8` (chụp màn hình), `chrono`, `uuid` (v4), `serde`

## Cấu trúc thư mục
```
src/                    Frontend React
  main.tsx              Entry point
  App.tsx               Toàn bộ UI — 1 file, các view là function component cùng file
  api.ts                Wrapper duy nhất quanh invoke() — mọi lời gọi backend đi qua đây
  types.ts              Type FE, map 1-1 với struct Rust
  styles.css            Toàn bộ CSS
src-tauri/
  src/lib.rs            Toàn bộ backend: struct, schema, seed, 10 tauri::command
  src/main.rs           Gọi sop_widget_lib::run()
  tauri.conf.json       Cấu hình cửa sổ widget + bundle
  capabilities/default.json  Permission Tauri (whitelist window API)
```

## Project Conventions

### Naming
- Rust: struct/enum PascalCase, hàm/biến snake_case, tauri command snake_case (`list_procedures`, `capture_evidence`)
- TypeScript: type PascalCase (`ProcedureInput`), hàm/biến camelCase (`loadProcedures`, `filteredProcedures`)
- File: TS dùng camelCase/PascalCase theo nội dung (`api.ts`, `App.tsx`); Rust dùng snake_case
- CSS class: kebab-case (`proc-item`, `progress-fill`, `settings-panel`)
- DB: bảng snake_case số nhiều (`procedures`, `steps`, `runs`, `step_executions`), cột snake_case

### Boundary FE ↔ Rust (quan trọng)
- **Payload trả về giữ nguyên snake_case** — `src/types.ts` khai báo đúng tên field của struct Rust
  (`order_index`, `requires_evidence`, `evidence_path`). KHÔNG camelCase hóa response.
- **Tham số truyền vào command dùng camelCase** — Tauri tự map sang snake_case của Rust:
  `invoke('confirm_step', { runId, stepId, notes })` → `fn confirm_step(run_id, step_id, notes)`.
  Xem `src/api.ts:8-14` và `src-tauri/src/lib.rs:87`.
- Mọi lời gọi backend mới **phải** thêm vào object `api` trong `src/api.ts`, không gọi `invoke`
  rải rác trong component.
- Thêm command mới: viết `#[tauri::command]` trong `lib.rs` **và** đăng ký trong
  `generate_handler![...]` ở cuối file (`lib.rs:103`), nếu quên sẽ lỗi runtime chứ không lỗi compile.

### DB Conventions
- Schema tạo bằng `CREATE TABLE IF NOT EXISTS` trong `db()` (`lib.rs:30-35`) — **không có migration tool**.
  Thêm cột cho DB đã tồn tại: dùng `let _ = conn.execute("ALTER TABLE ... ADD COLUMN ...", [])`
  ngay sau `execute_batch`, bỏ qua lỗi khi cột đã có (pattern ở `lib.rs:36`).
- PK: `id INTEGER PRIMARY KEY` (auto rowid); riêng `runs.id` là `TEXT` chứa UUID v4.
- FK: `{table_singular}_id` (`procedure_id`, `step_id`, `run_id`); `PRAGMA foreign_keys = ON`.
- Timestamp: cột TEXT chứa RFC3339 UTC, sinh bằng `now()` (`lib.rs:40`) — `created_at`, `updated_at`,
  `started_at`, `completed_at`, `confirmed_at`, `captured_at`.
- Soft delete: `procedures.archived` và `steps.archived` (`INTEGER NOT NULL DEFAULT 0`).
  **Không bao giờ `DELETE FROM steps`** — `step_executions.step_id` tham chiếu `steps(id)`
  không có `ON DELETE` rule và foreign key đang bật, nên xóa bước đã có lần chạy sẽ vi phạm
  ràng buộc. `save_procedure` archive toàn bộ step rồi bật lại `archived=0` cho step còn
  trong input, giữ nguyên step id để ảnh bằng chứng cũ không mất liên kết.
- Đọc step luôn qua `procedure_scoped()`, không tự viết query `FROM steps`:
  - `run_id=None` → chỉ step đang dùng (editor, picker, lần chạy mới)
  - lần chạy đang diễn ra → step đang dùng + step đã archive nhưng đã thực hiện trong run đó
  - lần chạy `completed`/`cancelled` → chỉ step đã thực hiện, để step thêm sau không lọt
    vào báo cáo cũ
- Idempotent write dùng `INSERT ... ON CONFLICT(run_id,step_id) DO UPDATE SET excluded.*`
  dựa trên `UNIQUE(run_id, step_id)` của `step_executions`.
- **Luôn dùng `params![]` / placeholder `?1`** — không nối chuỗi SQL.

### Error Handling
- Mọi command trả `Result<T, String>`; lỗi kỹ thuật map bằng `.map_err(|e| e.to_string())`.
- Message lỗi nghiệp vụ viết **tiếng Việt, hướng người dùng cuối** vì hiển thị thẳng lên UI
  (vd: `"Bước này yêu cầu ảnh bằng chứng trước khi xác nhận."`).
- FE bắt lỗi bằng `try/catch` quanh lời gọi `api.*`, đẩy vào `setNotice(String(e))`, `finally { setBusy(false) }`.
- Validate 2 lớp: chặn sớm ở FE (`save()` trong `App.tsx:61`) **và** validate lại trong command
  (`save_procedure`, `set_run_status`) — không tin FE.

### Style code
- **Rust**: mỗi `#[tauri::command]` viết gọn trên 1 dòng dài (`lib.rs:76-100`). Đây là style hiện
  hành của repo — giữ nguyên khi sửa/thêm command để diff không nhiễu. Command dài có logic
  nhiều nhánh (như `list_runs`) mới tách nhiều dòng.
- **React**: không tách file component; view mới thêm vào `App.tsx` dưới dạng function component
  ở cuối file, nhận props tường minh, không dùng context/state manager.
- State điều hướng qua `view: View` (`'picker' | 'runner' | 'done' | 'builder' | 'history'`) —
  không có router.
- Cờ `busy` dùng chung để disable button khi đang gọi backend.

### Cấu hình cửa sổ widget
- `tauri.conf.json`: `decorations: false`, `transparent: true`, `alwaysOnTop: true` — titlebar tự vẽ
  trong `App.tsx`, vùng kéo cửa sổ đánh dấu bằng `data-tauri-drag-region="true"`.
- Gọi window API (`minimize`, `close`) phải qua `getCurrentWindow()` và **kiểm tra
  `__TAURI_INTERNALS__`** trước, có fallback cho môi trường browser thuần (`App.tsx:35-58`) — vì
  `npm run dev` chạy được ngoài Tauri.
- Thêm window API mới → phải thêm permission tương ứng vào `src-tauri/capabilities/default.json`.
- Tùy chỉnh giao diện (độ trong suốt, màu nền) lưu ở `localStorage`, truyền xuống CSS qua
  custom property `--glass-transparency`, `--panel-color`.

### Test Conventions
Repo **chưa có test** và chưa cài test framework. Nếu thêm:
- Frontend: Vitest (đi cùng Vite), đặt cạnh file được test hoặc `src/__tests__/`
- Rust: `#[cfg(test)] mod tests` trong cùng file, `cargo test`
- Hỏi user trước khi thêm dependency test mới.

## Dữ liệu local
- DB: `%APPDATA%\NTA\SOP Widget\sop-widget.db`
- Ảnh bằng chứng: `%APPDATA%\NTA\SOP Widget\evidence\{run_id}\step-{step_id}-{timestamp}.png`
- Báo cáo HTML: `%APPDATA%\NTA\SOP Widget\reports\report-{run_id}-{timestamp}.html`

Đường dẫn gốc lấy từ `app_dir()` (`lib.rs:22`) — dựa trên env `APPDATA`, fallback `current_dir()`.

## Lệnh thường dùng
```powershell
npm.cmd install

# Dev (Tauri cần env Rust được set thủ công trên máy này)
$env:RUSTUP_HOME = "$env:USERPROFILE\.rustup"
$env:CARGO_HOME  = "$env:USERPROFILE\.cargo"
npm.cmd run tauri dev

npm.cmd run dev            # Chỉ frontend trên http://localhost:1420 (window API sẽ fallback)
npm.cmd run build          # tsc -b && vite build
npm.cmd run tauri build    # Installer → src-tauri\target\release\bundle
```

Type check nhanh: `npx tsc -b --noEmit` · Rust: `cargo check --manifest-path src-tauri/Cargo.toml`

## Quy tắc của project
1. **Không thêm khả năng thực thi lệnh/SSH.** Trường `command` của step chỉ để hiển thị — đây là
   ranh giới thiết kế của sản phẩm, không phải thiếu sót.
2. **Không nối chuỗi vào SQL** — luôn `params![]` với placeholder `?n`.
3. **Không escape thủ công ở chỗ khác cho báo cáo HTML** — dùng hàm `html()` (`lib.rs:101`) cho
   mọi giá trị nhúng vào report.
4. **Thêm command phải đăng ký vào `generate_handler!`** và thêm wrapper vào `src/api.ts` + type
   vào `src/types.ts` cùng lúc.
5. **Thay đổi schema phải tương thích ngược** — user đã có DB cũ ở `%APPDATA%`, không drop bảng,
   chỉ `ALTER TABLE ADD COLUMN` với `DEFAULT`.
6. **Không hardcode đường dẫn tuyệt đối** — luôn đi qua `app_dir()`.
7. Không thêm dependency (npm hoặc cargo) mà chưa hỏi — app đang cố ý giữ bundle nhỏ, zero-config.
