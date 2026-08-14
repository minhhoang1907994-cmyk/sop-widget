# SOP Widget

Ứng dụng desktop Windows: tạo/chạy SOP theo từng bước, chụp ảnh bằng chứng, lưu SQLite local,
xuất báo cáo HTML. App **không** tự thực thi lệnh hay SSH — lệnh chỉ là hướng dẫn hiển thị
cho người thực hiện.

Từ Phase 2, sản phẩm có thêm **server** (thư mục `server/`) giữ tài khoản người dùng và file
báo cáo được chia sẻ. Dữ liệu chạy SOP vẫn nằm hoàn toàn ở máy local và **không** đồng bộ lên
server. Đặc tả: `docs/spec/login-report-sharing.md`. Phần app của Phase 2 **chưa implement** —
hiện chỉ có backend.

## Tech Stack

### App desktop (`src/`, `src-tauri/`)
- Language: TypeScript 5.5 (frontend) · Rust edition 2021
- Framework: React 18.3 + Vite 5.3 · Tauri 2.0 (desktop shell)
- Database: SQLite local qua `rusqlite 0.32` (feature `bundled` — không cần cài SQLite ngoài)
- Frontend: React 18 + CSS thuần (`src/styles.css`), không dùng UI library / CSS framework
- Bundle: NSIS cho Windows (`tauri build`)
- Architecture: React SPA → Tauri IPC (`invoke`) → command trong `src-tauri/src/lib.rs` → SQLite
- Thư viện chính khác: `screenshots 0.8` (chụp màn hình), `chrono`, `uuid` (v4), `serde`, `sha2`, `base64`

### Server (`server/`)
- Language: TypeScript ESM trên Node 24 (`"type": "module"`, `module: NodeNext`)
- Framework: Fastify 5 — không dùng ORM, SQL viết tay bằng prepared statement
- Database: MySQL 8 / MariaDB qua `mysql2/promise`
- Mật khẩu: `@node-rs/argon2` (Argon2id). Chọn bản `@node-rs` vì có binary dựng sẵn,
  không cần C++ build tools trên Windows
- Test: Vitest — unit test cho logic thuần, integration test gọi API thật qua `app.inject()`
  với MySQL thật (không mock)
- Hạ tầng dev: Docker Compose (MySQL + api). Chưa có CI

## Cấu trúc thư mục
```
src/                    Frontend React
  main.tsx              Entry point
  App.tsx               Toàn bộ UI — 1 file, các view là function component cùng file
  api.ts                Wrapper duy nhất quanh invoke() — mọi lời gọi backend đi qua đây
  types.ts              Type FE, map 1-1 với struct Rust
  styles.css            Toàn bộ CSS
src-tauri/
  src/lib.rs            Toàn bộ lõi local: struct, schema, seed, 10 tauri::command
  src/main.rs           Gọi sop_widget_lib::run()
  tauri.conf.json       Cấu hình cửa sổ widget + bundle
  capabilities/default.json  Permission Tauri (whitelist window API)
server/                 Backend Phase 2 — tài khoản + chia sẻ báo cáo
  docker-compose.yml    MySQL + api cho môi trường dev
  .env.example          Mẫu cấu hình; .env thật KHÔNG commit
  db/migrations/*.sql   DDL, chạy tuần tự theo tên file
  db/migrate.ts         Runner migration, ghi vào bảng schema_migrations
  db/seed-admin.ts      Tạo admin đầu tiên, idempotent, không ghi đè mật khẩu đã có
  src/config.ts         Đọc env, ép TZ=UTC
  src/db.ts             Pool mysql2 + helper query/queryOne/execute/withTransaction
  src/errors.ts         ApiError + bảng mã lỗi, message tiếng Việt
  src/time.ts           Chỗ duy nhất chuyển đổi Date ↔ chuỗi DATETIME của MySQL
  src/rate-limit.ts     Bộ đếm đăng nhập sai, dùng chung kênh app và kênh web
  src/app.ts            buildApp() — plugin, error handler, đăng ký route
  src/index.ts          Bootstrap: mkdir storage → migrate → listen
  src/auth/             service (hash, session) · guard (Bearer/Cookie) · routes
  src/users/routes.ts   CRUD tài khoản, chỉ admin
  src/reports/          service · routes · storage (ghi file HTML ra đĩa)
  src/web/              routes + views cho /login, /logout, /r/:id
  test/                 unit.test.ts (logic thuần) · integration.test.ts (cần MySQL)
```

## Project Conventions

### Naming
- Rust: struct/enum PascalCase, hàm/biến snake_case, tauri command snake_case (`list_procedures`, `capture_evidence`)
- TypeScript: type PascalCase (`ProcedureInput`), hàm/biến camelCase (`loadProcedures`, `filteredProcedures`)
- File: TS dùng camelCase/PascalCase theo nội dung (`api.ts`, `App.tsx`); Rust dùng snake_case
- CSS class: kebab-case (`proc-item`, `progress-fill`, `settings-panel`)
- DB: bảng snake_case số nhiều (`procedures`, `steps`, `runs`, `step_executions`, `users`, `sessions`,
  `reports`, `report_recipients`), cột snake_case
- Server: file kebab-case/lowercase (`rate-limit.ts`, `seed-admin.ts`), mã lỗi SCREAMING_SNAKE
  (`INVALID_CREDENTIALS`, `LAST_ADMIN`)

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

### Boundary app ↔ server (HTTP)
Đây là boundary **thứ hai** của project, đừng lẫn với boundary IPC ở trên.
- **Payload JSON dùng snake_case cả hai chiều** — request body, query param và response đều
  snake_case (`display_name`, `recipient_ids`, `next_cursor`). Không camelCase hóa.
- Bọc dữ liệu thành công trong `{ "data": ... }`; danh sách phân trang thêm `next_cursor` cùng cấp.
- Lỗi luôn có dạng `{ "error": { "code": "...", "message": "..." } }` — `code` là hằng
  SCREAMING_SNAKE để code xử lý, `message` là tiếng Việt để hiển thị thẳng cho người dùng.
- Mã lỗi mới **phải** thêm vào object `errors` trong `server/src/errors.ts`, không tạo `ApiError`
  rải rác trong route.
- Thời gian đi qua API là RFC3339 có offset (`2026-08-14T01:42:00.000Z`); trong DB là UTC không
  offset. Chuyển đổi chỉ làm ở `server/src/time.ts`.
- Kênh xác thực: app dùng `Authorization: Bearer <token>`, trình duyệt dùng cookie `sop_session`
  (`HttpOnly`). Hai kênh sinh hai row `sessions` độc lập, phân biệt bằng cột `client`.
- Khi thêm command Tauri gọi server: vẫn phải qua `src/api.ts` + `src/types.ts` như mọi command khác.

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

### DB Conventions — MySQL (`server/`)
- **Có migration tool riêng của repo**: `server/db/migrate.ts` chạy mọi `.sql` trong
  `db/migrations/` theo thứ tự tên file, ghi tên đã chạy vào bảng `schema_migrations`.
  Thêm schema mới = thêm file `002_*.sql`, **không sửa file cũ** đã chạy trên DB thật.
  Runner này tự chạy khi khởi động (`src/index.ts`) nên gọi lại nhiều lần phải an toàn.
- Kiểu cột: PK `BIGINT UNSIGNED AUTO_INCREMENT`; id do server sinh dùng `CHAR(36)` chứa UUID v4.
  Thời gian dùng `DATETIME(3)`, **luôn là UTC** — cả MySQL và tiến trình Node đều chạy `TZ=UTC`.
- Soft delete: `users.is_active` (không có `DELETE FROM users`), giống tinh thần `archived`
  của `procedures`/`steps`.
- **Luôn dùng placeholder `?`** qua helper trong `src/db.ts` — không nối chuỗi SQL.
  Với `IN (...)` thì sinh đúng số dấu `?` theo độ dài mảng, không nội suy giá trị.
- Ghi nhiều bảng trong một thao tác nghiệp vụ → `withTransaction()`.
- File báo cáo lưu ra đĩa, **DB chỉ giữ đường dẫn tương đối** so với `STORAGE_DIR`; mọi lần
  dựng đường dẫn tuyệt đối phải đi qua `absolutePathFor()` (có chặn path traversal).

### Error Handling
- Mọi command trả `Result<T, String>`; lỗi kỹ thuật map bằng `.map_err(|e| e.to_string())`.
- Message lỗi nghiệp vụ viết **tiếng Việt, hướng người dùng cuối** vì hiển thị thẳng lên UI
  (vd: `"Bước này yêu cầu ảnh bằng chứng trước khi xác nhận."`).
- FE bắt lỗi bằng `try/catch` quanh lời gọi `api.*`, đẩy vào `setNotice(String(e))`, `finally { setBusy(false) }`.
- Validate 2 lớp: chặn sớm ở FE (`save()` trong `App.tsx:61`) **và** validate lại trong command
  (`save_procedure`, `set_run_status`) — không tin FE.
- Server: ném `ApiError` từ bảng `errors` (`server/src/errors.ts`), error handler trong
  `src/app.ts` tự chuyển thành HTTP status + body. Không tự `reply.code(...).send(...)` cho lỗi.
- **Phân quyền phải kiểm ở server**, không chỉ ẩn nút trên UI — ẩn nút thì gọi thẳng API là đi vòng được.
- Với dữ liệu người gọi không có quyền đọc: trả `404`, **không** `403`, để id không trở thành
  thứ dò được (BR-31). `403` chỉ dùng khi thiếu quyền theo role.

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
- **`server/` đã có Vitest** — `server/test/unit.test.ts` (logic thuần, không cần DB) và
  `server/test/integration.test.ts` (gọi API thật qua `app.inject()`, cần MySQL đang chạy).
- **Test chạy trên database riêng `sop_widget_test`**, không phải `sop_widget` của dev.
  `vitest.config.ts` ép `DB_NAME` và `LOG_LEVEL` qua `test.env`; `dotenv` không ghi đè biến
  đã có nên hai giá trị đó luôn thắng `.env`. **Không bỏ cấu hình này**: integration test xóa
  sạch bảng trong `beforeEach`, trỏ vào DB dev là mất hết dữ liệu kể cả tài khoản admin.
- Integration test xóa bảng theo thứ tự tôn trọng FK (`report_recipients` → `reports` →
  `sessions` → `users`) và gọi `resetLoginLimiter()` để bộ đếm đăng nhập không rỉ giữa các case.
- `fileParallelism: false` — các file test dùng chung một database nên không chạy song song được.
- Test tên bằng tiếng Việt, trích dẫn BR hoặc số test scenario của spec khi có
  (vd: `'người ngoài nhận 404, không phải 403 (Security Test #5)'`) để truy được về đặc tả.
- **`src/` và `src-tauri/` vẫn chưa có test.** Nếu thêm: Vitest cho frontend (đặt cạnh file
  được test hoặc `src/__tests__/`), `#[cfg(test)] mod tests` trong cùng file cho Rust.
- Hỏi user trước khi thêm dependency test mới.

## Dữ liệu local
- DB: `%APPDATA%\NTA\SOP Widget\sop-widget.db`
- Ảnh bằng chứng: `%APPDATA%\NTA\SOP Widget\evidence\{run_id}\step-{step_id}-{timestamp}.png`
- Báo cáo HTML: `%APPDATA%\NTA\SOP Widget\reports\report-{run_id}-{timestamp}.html`

Đường dẫn gốc lấy từ `app_dir()` (`lib.rs:22`) — dựa trên env `APPDATA`, fallback `current_dir()`.

## Dữ liệu trên server
- Hai database: **`sop_widget`** (dev/thật) và **`sop_widget_test`** (chỉ dành cho Vitest).
  DB test được tạo bởi `server/db/init/001-create-test-database.sql`, chạy tự động khi container
  MySQL khởi tạo lần đầu. Nếu volume `db-data` đã tồn tại thì script không chạy lại — lúc đó tạo
  tay bằng `mysql -uroot` rồi `GRANT` cho user `sop`.
- MySQL: 4 bảng `users`, `sessions`, `reports`, `report_recipients` (+ `schema_migrations`)
- File báo cáo: `STORAGE_DIR/{yyyy}/{MM}/{report_id}.html` — mặc định `server/storage/reports`
  ở môi trường dev, `/data/reports` trong container
- Ảnh bằng chứng **không** được upload riêng; chúng đã nhúng base64 trong chính file HTML

## Lệnh thường dùng

### App desktop
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

### Server
```powershell
cd server
Copy-Item .env.example .env      # rồi sửa mật khẩu; .env KHÔNG commit
npm.cmd install

docker compose up -d db          # chỉ MySQL, app chạy ở host
npm.cmd run migrate              # chạy db/migrations/*.sql
npm.cmd run seed:admin           # tạo admin đầu tiên (idempotent)
npm.cmd run dev                  # tsx watch, mặc định http://localhost:8080

npm.cmd run type-check
npm.cmd run build
npm.cmd test                     # Vitest, tự trỏ sang DB sop_widget_test
docker compose down              # dừng container
```

Trên máy này MySQL map ra **cổng 3307** (xem `server/.env`) để không đụng MySQL sẵn có.
Docker Desktop phải chạy trước, nếu không `docker` báo không kết nối được engine.

## Quy tắc của project
1. **Không thêm khả năng thực thi lệnh/SSH.** Trường `command` của step chỉ để hiển thị — đây là
   ranh giới thiết kế của sản phẩm, không phải thiếu sót.
2. **Không nối chuỗi vào SQL** — SQLite dùng `params![]` với `?n`, MySQL dùng helper trong
   `server/src/db.ts` với `?`.
3. **Không escape thủ công ở chỗ khác cho báo cáo HTML** — dùng hàm `html()` (`lib.rs:101`) phía
   Rust và `escapeHtml()` (`server/src/web/views.ts`) phía server.
4. **Thêm command phải đăng ký vào `generate_handler!`** và thêm wrapper vào `src/api.ts` + type
   vào `src/types.ts` cùng lúc.
5. **Thay đổi schema phải tương thích ngược** — user đã có DB cũ ở `%APPDATA%`, không drop bảng,
   chỉ `ALTER TABLE ADD COLUMN` với `DEFAULT`. Phía MySQL: thêm file migration mới, không sửa
   file đã chạy.
6. **Không hardcode đường dẫn tuyệt đối** — phía app đi qua `app_dir()`, phía server đi qua
   `config.storageDir` + `absolutePathFor()`.
7. Không thêm dependency (npm, cargo, hay trong `server/`) mà chưa hỏi — app đang cố ý giữ bundle
   nhỏ, zero-config; server cố ý không dùng ORM.
8. **Dữ liệu chạy SOP không lên server.** `procedures`, `steps`, `runs`, `step_executions` và
   thư mục `evidence/` là dữ liệu local. Server chỉ giữ tài khoản và file báo cáo đã hoàn tất.
   Đây là quyết định thiết kế đã chốt (BR-20), không phải giới hạn tạm thời.
9. **Không commit `.env`.** Chỉ commit `.env.example` với giá trị placeholder. Mật khẩu, token,
   connection string thật không bao giờ nằm trong repo.
10. **Chưa deploy lên server thật khi chưa có HTTPS.** Máy chủ hiện cấu hình `http://` trên IP
    công cộng; báo cáo có thể chứa ảnh màn hình có credential. Chạy Docker local thì được.
