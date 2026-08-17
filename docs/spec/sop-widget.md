# SOP Widget — Specification

## 1. Tổng quan (Overview)
- **Mục đích**: Ứng dụng desktop (Windows và macOS) giúp kỹ sư vận hành thực hiện quy trình chuẩn (SOP) theo từng bước có kiểm chứng, ép chụp ảnh màn hình làm bằng chứng ở bước bắt buộc, và xuất báo cáo HTML một file để gửi cho leader.
- **Actor**: Kỹ sư vận hành (người cài và chạy app trên máy của chính mình)
- **Priority**: High
- **Phase**: Phase 1 (MVP) + Phase 1.1 (các mục đánh dấu `[SỬA]` / `[MỚI]` trong tài liệu này) — **cả hai đã implement**
- **Ngày soạn**: 2026-08-13
- **Version**: 1.4

> **Phạm vi của tài liệu này**: mô tả phần chạy SOP tại máy người dùng. Toàn bộ dữ liệu quy trình, lần chạy và ảnh bằng chứng nằm ở máy local và **không** đồng bộ lên server.
>
> Từ Phase 2, sản phẩm **không còn chạy offline hoàn toàn**: app yêu cầu đăng nhập bằng tài khoản trên server, và báo cáo được chia sẻ cho thành viên khác qua server. Phần đó đặc tả ở [`login-report-sharing.md`](login-report-sharing.md) và **chưa được implement**. Các mục bị Phase 2 thay đổi trong tài liệu này được đánh dấu `[Phase 2]`.

## 2. User Story
> As a **kỹ sư vận hành**, I want to **chạy quy trình deploy/backup theo từng bước với ảnh bằng chứng bắt buộc** so that **tôi không nhảy sót bước và có báo cáo gửi leader chứng minh đã làm đúng trình tự**.

## 3. Actors & Permissions

| Actor | Quyền | Điều kiện |
|---|---|---|
| Kỹ sư vận hành | Toàn quyền create / read / update / archive quy trình; chạy SOP; xuất báo cáo | Trên máy của chính mình |
| Leader / auditor | Chỉ đọc báo cáo HTML nhận được | Ngoài app, không có tài khoản trong hệ thống |

**Hiện tại (Phase 1.1 — đang chạy)**: app không có cơ chế đăng nhập hay phân quyền. Mọi người dùng trên cùng một tài khoản hệ điều hành đều có toàn quyền với dữ liệu trong thư mục dữ liệu của tài khoản đó (`%APPDATA%\NTA\SOP Widget` trên Windows, `~/Library/Application Support/NTA/SOP Widget` trên macOS).

**`[Phase 2]`**: bổ sung hai role **Admin** và **Member** với tài khoản trên server — xem [`login-report-sharing.md`](login-report-sharing.md) §3. Quyền tạo/sửa/archive quy trình vẫn là quyền local của mọi người dùng trên máy của họ, không phân biệt role (xem Q11 của tài liệu đó).

## 4. Entity Schema

### 4.1 Entities bị ảnh hưởng

| Entity | Thao tác | Ghi chú |
|---|---|---|
| `procedures` | CREATE / READ / UPDATE | Existing |
| `steps` | CREATE / READ / UPDATE | Existing |
| `runs` | CREATE / READ / UPDATE | Existing |
| `step_executions` | CREATE / READ / UPDATE | Existing — `[SỬA]` thêm cột `evidence_hash` |

Schema tạo bằng `CREATE TABLE IF NOT EXISTS` khi mở connection; cột thêm mới dùng `ALTER TABLE ADD COLUMN` bỏ qua lỗi trùng. Không có migration tool.

Ngoài `ALTER TABLE`, `db()` còn chạy một câu lệnh chuẩn hóa dữ liệu idempotent: đổi mọi run `paused` sang `cancelled` (xem BR-12).

**Lưu ý vận hành**: `db()` được gọi ở mọi command, kể cả command chỉ đọc. Nghĩa là **không có command nào là read-only thuần** — mọi lời gọi đều mở connection ghi được và chạy `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`, câu migration trạng thái, và kiểm tra seed. Sau lần đầu, các câu này khớp 0 row nên chi phí không đáng kể, nhưng DB phải luôn ở chế độ ghi được.

### 4.2 Schema chi tiết

**`procedures`** (existing)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | INTEGER | NO | rowid | PK | |
| name | TEXT | NO | | | Tên quy trình |
| description | TEXT | NO | `''` | | |
| category | TEXT | YES | NULL | | Quyết định icon/màu trên UI |
| created_at | TEXT | NO | | | RFC3339 UTC |
| updated_at | TEXT | NO | | | RFC3339 UTC |
| archived | INTEGER | NO | 0 | | Soft delete |

**`steps`** (existing)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | INTEGER | NO | rowid | PK | |
| procedure_id | INTEGER | NO | | FK → `procedures.id` ON DELETE CASCADE | |
| order_index | INTEGER | NO | | | Thứ tự hiển thị, đánh lại từ 0 mỗi lần lưu |
| title | TEXT | NO | | | |
| description | TEXT | NO | `''` | | |
| command | TEXT | YES | NULL | | Chỉ hiển thị, app không thực thi |
| requires_evidence | INTEGER | NO | 0 | | Bắt buộc ảnh trước khi xác nhận |
| archived | INTEGER | NO | 0 | | Soft delete — bước bị bỏ vẫn giữ lại |

**`runs`** (existing)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | TEXT | NO | | PK | UUID v4 |
| procedure_id | INTEGER | NO | | FK → `procedures.id` | |
| status | TEXT | NO | | | `running` / `completed` / `cancelled`. Giá trị `paused` của phiên bản cũ được tự động chuyển sang `cancelled` khi mở DB |
| started_at | TEXT | NO | | | RFC3339 UTC |
| completed_at | TEXT | YES | NULL | | Set khi `completed` |
| **operator_name** | **TEXT** | **YES** | **NULL** | | **`[MỚI]` Tên người thực hiện, chụp lại tại thời điểm `start_run`. Run cũ trước khi có cột này mang NULL** |

**`step_executions`** (existing + 1 cột mới)

| Column | Type | Nullable | Default | Constraint | Description |
|---|---|---|---|---|---|
| id | INTEGER | NO | rowid | PK | |
| run_id | TEXT | NO | | FK → `runs.id`, UNIQUE(run_id, step_id) | |
| step_id | INTEGER | NO | | FK → `steps.id` — **không có ON DELETE** | |
| confirmed_at | TEXT | YES | NULL | | |
| notes | TEXT | YES | NULL | | |
| evidence_path | TEXT | YES | NULL | | Đường dẫn tuyệt đối tới PNG |
| captured_at | TEXT | YES | NULL | | |
| **evidence_hash** | **TEXT** | **YES** | **NULL** | | **`[MỚI]` SHA-256 hex của file PNG tại thời điểm chụp** |

**Ràng buộc quan trọng**: `step_executions.step_id` tham chiếu `steps(id)` không có `ON DELETE` rule và `PRAGMA foreign_keys = ON`. Vì vậy **cấm `DELETE FROM steps`** ở mọi nơi — bước bị bỏ phải set `archived = 1`.

## 5. Tauri Command Contract

Thay cho REST API. Frontend gọi qua `invoke()`, wrapper tập trung ở `src/api.ts`. Tham số truyền vào camelCase, Tauri map sang snake_case của Rust. Payload trả về giữ nguyên snake_case.

### 5.1 Danh sách command

| Command | Params | Returns | Description |
|---|---|---|---|
| `list_procedures` | — | `Procedure[]` | Chỉ `archived = 0`, sort `updated_at DESC` |
| `save_procedure` | `input: ProcedureInput` | `Procedure` | Create hoặc update |
| `delete_procedure` | `id: i64` | `void` | Soft delete — `[SỬA]` UI phải gọi |
| `start_run` | `procedureId: i64`, `operatorName: String` | `Run` | `[SỬA]` Tạo run mới status `running`, ghi lại tên người thực hiện |
| `get_run` | `runId: String` | `RunDetails` | Scope step theo trạng thái run |
| `list_runs` | — | `Run[]` | Kèm `procedure_name`, `confirmed_count`, `evidence_count` |
| `confirm_step` | `runId, stepId, notes` | `void` | Chặn nếu thiếu bằng chứng hoặc run đã kết thúc |
| `capture_evidence` | `runId, stepId` | `String` (path) | `[SỬA]` tính thêm SHA-256; chặn nếu run đã kết thúc |
| `set_run_status` | `runId, status` | `void` | Whitelist `[SỬA]`: `running` / `completed` / `cancelled` |
| `export_report` | `runId` | `String` (path) | `[SỬA]` nhúng ảnh base64 |

Mọi command trả `Result<T, String>`. Command mới phải đăng ký trong `generate_handler!` — thiếu sẽ lỗi runtime chứ không lỗi compile.

**`list_runs` cố ý không lọc `procedures.archived`**: run của quy trình đã archive **vẫn hiện trong History**. Đây là chủ đích — archive quy trình không được làm mất dấu vết các lần đã chạy và bằng chứng kèm theo (xem BR-14).

### 5.2 Chi tiết command có ràng buộc nghiệp vụ

**`save_procedure(input)`**

| Field | Type | Required | Validation |
|---|---|---|---|
| `input.id` | `Option<i64>` | No | `> 0` → update; ngược lại → create |
| `input.name` | String | Yes | Không rỗng sau `trim()` |
| `input.description` | String | Yes | Cho phép rỗng |
| `input.category` | `Option<String>` | No | |
| `input.steps` | `StepInput[]` | Yes | Ít nhất 1 phần tử |
| `input.steps[].id` | `Option<i64>` | No | Có id → update tại chỗ; không có → insert mới |
| `input.steps[].title` | String | Yes | Không rỗng sau `trim()` |
| `input.steps[].requires_evidence` | bool | Yes | |

Xử lý: mở transaction → update/insert `procedures` → `UPDATE steps SET archived = 1 WHERE procedure_id = ?` → với từng step trong input, `UPDATE ... SET archived = 0` theo id, nếu không khớp row nào thì `INSERT` → commit.

Errors:

| Condition | Message |
|---|---|
| Tên rỗng, steps rỗng, hoặc có step thiếu title | `Quy trình cần có tên và ít nhất một bước hợp lệ.` |
| Lỗi SQLite | Message gốc của rusqlite |

**`start_run(procedureId, operatorName)`** `[SỬA]`

| Field | Type | Required | Validation |
|---|---|---|---|
| `procedureId` | i64 | Yes | Quy trình phải tồn tại |
| `operatorName` | String | Yes | Cho phép rỗng — khi rỗng, lưu NULL và báo cáo in `(chưa đặt tên)` |

Frontend lấy `operatorName` từ Settings (`localStorage`) và truyền xuống. Backend **không** đọc được `localStorage`, nên tên phải đi qua tham số này.

**`[Phase 2 — đã implement]`** `operatorName` **bị bỏ khỏi chữ ký lệnh**. `start_run(procedureId)` tự đọc `display_name` của tài khoản đang đăng nhập và ghi thêm `runs.operator_user_id`; lệnh trả lỗi `Bạn cần đăng nhập trước khi thực hiện thao tác này.` khi chưa có phiên.

> v1.2 của tài liệu này ghi "chữ ký lệnh không đổi — chỉ đổi nguồn dữ liệu". Điều đó **sai** và đã được sửa ở v1.3: nếu frontend vẫn truyền tên xuống thì vẫn khai được tên bất kỳ, và mục tiêu chống khai gian — lý do tồn tại của cả tính năng đăng nhập — không đạt. Xem BR-23 của [`login-report-sharing.md`](login-report-sharing.md).

**`confirm_step(runId, stepId, notes)`**

| Condition | Message |
|---|---|
| `runs.status != 'running'` | `Lần chạy này đã kết thúc, không thể xác nhận thêm bước.` |
| `requires_evidence = 1` và `evidence_path IS NULL` | `Bước này yêu cầu ảnh bằng chứng trước khi xác nhận.` |

Kiểm tra trạng thái run **trước** khi kiểm tra bằng chứng. Thành công: `INSERT ... ON CONFLICT(run_id, step_id) DO UPDATE SET confirmed_at, notes`.

**`capture_evidence(runId, stepId)`** `[SỬA]`

Chụp màn hình đầu tiên trả về từ `Screen::all()` → lưu `evidence/{run_id}/step-{step_id}-{yyyyMMdd-HHmmss}.png` → **tính SHA-256 của file vừa ghi** → upsert `evidence_path`, `captured_at`, `evidence_hash`.

| Condition | Message |
|---|---|
| `runs.status != 'running'` | `Lần chạy này đã kết thúc, không thể chụp thêm bằng chứng.` |
| Không truy cập được màn hình | `Không thể truy cập màn hình: {lỗi}` |
| Không tìm thấy màn hình | `Không tìm thấy màn hình để chụp.` |
| Chụp thất bại | `Chụp màn hình thất bại: {lỗi}` |

Kiểm tra trạng thái run **trước** khi chụp, để không sinh file PNG rác cho run đã đóng.

**`set_run_status(runId, status)`** `[SỬA]`

| Condition | Message |
|---|---|
| `status` ngoài `running` / `completed` / `cancelled` | `Trạng thái không hợp lệ.` |

`completed_at` chỉ set khi status = `completed`.

**`export_report(runId)`** `[SỬA]`

Đọc `RunDetails` → in phần đầu báo cáo gồm tên quy trình, mã run, **tên người thực hiện lấy từ `runs.operator_name`**, trạng thái, thời gian bắt đầu và hoàn tất → với mỗi step có `evidence_path`, đọc file PNG, encode base64, nhúng `<img src="data:image/png;base64,...">` → in kèm `evidence_hash` dạng text dưới ảnh → ghi `reports/report-{run_id}-{yyyyMMdd-HHmmss}.html`.

Xuất báo cáo được phép ở **mọi trạng thái run**, kể cả `running` — dùng để lấy báo cáo giữa chừng.

| Condition | Xử lý |
|---|---|
| File ảnh không còn tồn tại | In dòng `Ảnh bằng chứng không tìm thấy tại: {path}` thay cho thẻ `<img>`, **không** làm fail cả báo cáo |
| `evidence_hash` NULL (dữ liệu cũ trước khi thêm cột) | In `(chưa có hash)` thay vì để trống |
| `operator_name` NULL hoặc rỗng | In `(chưa đặt tên)` |
| Lỗi đọc/ghi file | Trả `Err` với message gốc |

Mọi giá trị nhúng vào HTML phải đi qua hàm `html()` để escape `& < > "`.

## 6. Điều kiện tiên quyết (Preconditions)
- [ ] App đã cài trên máy Windows hoặc macOS của người vận hành
- [ ] Thư mục dữ liệu ghi được — `%APPDATA%\NTA\SOP Widget` (Windows) hoặc `~/Library/Application Support/NTA/SOP Widget` (macOS)
- [ ] Trên macOS: đã cấp quyền **Screen Recording** cho app, nếu không `capture_evidence` sẽ lỗi ở bước bắt buộc ảnh bằng chứng
- [ ] Quy trình cần chạy đã tồn tại và chưa bị archive
- [ ] Người vận hành đã điền tên trong Settings **trước khi bắt đầu chạy** — tên được chụp lại vào `runs.operator_name` tại thời điểm `start_run`. Đổi tên trong Settings sau đó **không** làm thay đổi run đã tạo. Nếu bỏ trống, báo cáo in `(chưa đặt tên)`
- [ ] `[Phase 2]` Thay điều kiện trên bằng: **người vận hành đã đăng nhập**. Ô tên tự nhập trong Settings bị bỏ; tên lấy từ tài khoản (BR-23 của [`login-report-sharing.md`](login-report-sharing.md))

## 7. Luồng chính (Main Flow)

| # | Actor | Hành động | System Response |
|---|---|---|---|
| 1 | Người vận hành | Mở app | Load danh sách quy trình chưa archive |
| 2 | Người vận hành | Chọn quy trình | Tạo run mới (`running`), ghi `operator_name` từ Settings, hiện bước đầu tiên |
| 3 | System | — | Hiện tiêu đề, mô tả, lệnh tham khảo, thanh tiến độ |
| 4 | Người vận hành | Tự thực hiện thao tác ngoài app | — |
| 5 | Người vận hành | Bấm "Chụp bằng chứng" (nếu bước bắt buộc) | Chụp màn hình, lưu PNG, tính SHA-256, hiện dấu đã chụp |
| 6 | Người vận hành | Nhập ghi chú (tùy chọn), bấm "Xác nhận hoàn thành" | Kiểm tra bằng chứng → ghi `confirmed_at` + `notes` → sang bước kế |
| 7 | System | Khi bước cuối được xác nhận | Set run `completed`, hiện màn hình tổng kết |
| 8 | Người vận hành | Bấm "Xuất báo cáo" | Sinh HTML một file có ảnh nhúng, trả về đường dẫn |
| 9 | Người vận hành | Gửi file HTML cho leader (ngoài app) | — |

## 7b. Flow Diagram

```
([Operator]) → [Open app] → [Pick procedure] → [start_run]
                                                    ↓
                                            [Show current step]
                                                    ↓
                                        <requires_evidence?>
                                    ↓ Yes                    ↓ No
                            [capture_evidence]                │
                            [save PNG + SHA-256]              │
                                    ↓                         │
                                    └───────→ [confirm_step] ←┘
                                                    ↓
                                            <evidence present?>
                                    ↓ No                     ↓ Yes
                            [Reject: show notice]    [Write confirmed_at]
                                    ↑                         ↓
                                    └───────────────  <last step?>
                                                    ↓ No        ↓ Yes
                                            [Next step]   [status=completed]
                                                                ↓
                                                        [export_report]
                                                        [embed base64]
                                                                ↓
                                                        ([Leader reads HTML])
```

> Mermaid source: [assets/sop-widget-img1.mmd](assets/sop-widget-img1.mmd) — render tại https://mermaid.live

## 8. Luồng thay thế (Alternative Flows)

### 8.1 Hủy lần chạy giữa chừng `[SỬA]`
- Kích hoạt: tại bước bất kỳ, người vận hành bấm "Hủy lần chạy"
- Luồng: set run status `cancelled` → quay về danh sách quy trình
- Kết quả: các bước đã xác nhận **vẫn được giữ** trong `step_executions`; run này **không chạy tiếp được**, chỉ xem/xuất báo cáo từ History

### 8.2 Xuất lại báo cáo từ History
- Kích hoạt: người vận hành mở History, bấm "Xuất HTML" ở một run cũ
- Luồng: `export_report` sinh file mới với timestamp mới
- Kết quả: nhiều file báo cáo cho cùng một run là hợp lệ, không ghi đè nhau

### 8.3 Sửa quy trình đã từng chạy
- Kích hoạt: mở Builder trên quy trình đã có run
- Luồng: bước bị bỏ → `archived = 1`; bước giữ lại → update tại chỗ, giữ nguyên id
- Kết quả: báo cáo của run cũ vẫn hiện đủ bước và ảnh bằng chứng

### 8.4 Archive quy trình `[MỚI]`
- Kích hoạt: trong Builder, người vận hành bấm "Xóa quy trình" trên một quy trình đang mở
- Luồng:
  1. Hiện hộp xác nhận nêu rõ: quy trình sẽ biến mất khỏi danh sách, nhưng lịch sử và bằng chứng của các lần đã chạy vẫn giữ nguyên
  2. Người vận hành xác nhận → gọi `delete_procedure(id)` → set `archived = 1`, cập nhật `updated_at`
  3. Quay về danh sách quy trình
- Kết quả: quy trình không còn trong Picker và Builder; các run cũ **vẫn hiện trong History** và vẫn xuất được báo cáo (BR-14)
- Ràng buộc: không chặn khi quy trình đang có run ở trạng thái `running`. Run đó vẫn chạy tiếp bình thường tới khi hoàn thành hoặc bị hủy

## 9. Luồng lỗi (Exception Flows)
- Ép bằng chứng: đã mô tả ở mục 5.2 `confirm_step`
- Chụp màn hình thất bại: hiện notice, người vận hành thử lại; bước vẫn bị chặn xác nhận
- Ảnh bị xóa khỏi đĩa trước khi xuất báo cáo: báo cáo in dòng cảnh báo thay cho ảnh, không fail

## 10. Business Rules

- **BR-01**: A step with `requires_evidence = 1` cannot be confirmed while `evidence_path` is NULL. Enforced in the backend command, not only in the UI.
- **BR-02**: Steps are never deleted. Removing a step from a procedure sets `archived = 1` and keeps the row.
- **BR-03**: A step id is stable across edits, so evidence captured by earlier runs keeps pointing at the same step.
- **BR-04**: The editor, the picker and any new run see only steps with `archived = 0`.
- **BR-05**: A run in progress sees active steps plus archived steps it has already executed.
- **BR-06**: A run with status `completed` or `cancelled` sees exactly the steps it executed, so steps added later never appear in an older report.
- **BR-07**: A run reaches `completed` only when every step visible to that run has `confirmed_at` set.
- **BR-08**: A run set to `cancelled` cannot return to `running`.
- **BR-09**: `evidence_hash` is computed once, from the PNG file, immediately after it is written. It is never recomputed on export.
- **BR-10**: The exported HTML embeds every available evidence image as a base64 data URI, so the file is readable on a machine that has none of the original PNG files.
- **BR-11**: The application never executes the `command` field. It is display text only.
- **BR-12**: `paused` is a legacy value. On database open, every run still carrying it is rewritten to `cancelled`. The migration is idempotent and one-way — there is no path back to `paused`.
- **BR-13**: `confirm_step` and `capture_evidence` must reject any run whose status is not `running`. A closed run accepts no further evidence and no further confirmation. `export_report` is exempt and works on any status.
- **BR-14**: Archiving a procedure hides it from the picker and the editor but never hides its past runs. History lists runs of archived procedures, and their reports stay exportable.
- **BR-15**: `operator_name` is captured into the run at `start_run` and is never rewritten. Changing the name in Settings afterwards does not alter runs that already exist. **`[Phase 2]` superseded by BR-23 of [`login-report-sharing.md`](login-report-sharing.md)**: the name is taken from the signed-in account instead of a free-text field. The snapshot-at-`start_run` behaviour itself is unchanged — only the source of the value.

## 11. State Machine — `runs.status` `[SỬA]`

| Trạng thái hiện tại | Event | Trạng thái tiếp theo | Điều kiện |
|---|---|---|---|
| — | `start_run` | `running` | Quy trình tồn tại |
| `running` | Xác nhận bước cuối | `completed` | Mọi bước đã `confirmed_at` |
| `running` | Bấm "Hủy lần chạy" | `cancelled` | Bất kỳ lúc nào |
| `completed` | — | — | Trạng thái cuối |
| `cancelled` | — | — | Trạng thái cuối |
| `paused` (dữ liệu cũ) | Mở DB lần đầu sau khi nâng cấp | `cancelled` | Tự động, một chiều |

Trạng thái `paused` bị loại bỏ vì trùng ngữ nghĩa với `cancelled` theo quyết định nghiệp vụ đã chốt ngày 2026-08-13.

### 11.1 Nhãn hiển thị trên UI

| `status` | Nhãn trong History | Nhãn trong báo cáo HTML |
|---|---|---|
| `running` | `▶ Đang chạy` | `Đang chạy` |
| `completed` | `✓ Hoàn thành` | `Hoàn thành` |
| `cancelled` | `✕ Đã hủy` | `Đã hủy` |

Không được dùng nhãn "Tạm dừng" ở bất kỳ đâu — trạng thái đó không còn tồn tại.

## 12. Security & Authorization

- **Authentication**: not required in Phase 1.1 — the app has no login and no user accounts. **`[Phase 2]` authentication becomes mandatory for the whole application**: a valid server session is required to open the app at all. See [`login-report-sharing.md`](login-report-sharing.md) §12.
- **Authorization**: none in Phase 1.1. Anyone with access to the operating-system account has full control over the local data. **`[Phase 2]` adds Admin/Member roles for account management and per-object access control on shared reports — but not on local SOP data, which stays fully accessible to whoever owns the operating-system account.**
- **Rate limiting**: N/A in Phase 1.1 — local IPC only, no network surface. **`[Phase 2]` the login endpoint is rate limited server-side.**
- **Input validation**: all SQL uses `params![]` with `?n` placeholders, never string concatenation. All values interpolated into the exported HTML pass through `html()` which escapes `& < > "`.
- **Sensitive data**: evidence screenshots may capture credentials, tokens or customer data visible on screen at capture time. The application does not detect or mask this. **The operator is responsible for what is on screen when capturing.**
- **Tamper resistance**: `evidence_hash` detects a PNG replaced on disk after capture, when compared against the local database. It does **not** make an exported report trustworthy to a third party: the operator can edit the HTML file, including the printed hash, before sending it. Anyone reading this specification must not treat the report as tamper-proof evidence.
- **Data at rest**: unencrypted SQLite file and unencrypted PNG files in the user profile.
- **`[Phase 2]` Data in transit**: reports leave the machine. The exported HTML embeds the evidence screenshots, so everything noted under *Sensitive data* above now travels over the network and is stored on a shared server. Transport encryption is therefore a deployment blocker, not a nice-to-have — see [`login-report-sharing.md`](login-report-sharing.md) §12.

## 13. Integration Contract (người nhận báo cáo)

Không có frontend/consumer lập trình. "Consumer" duy nhất là người mở file HTML.

- **Định dạng**: một file `.html` đứng riêng, mở bằng trình duyệt bất kỳ, không cần internet
- **Ảnh**: nhúng base64, không phụ thuộc file ngoài
- **Kích thước**: xem mục 15
- **Không có**: link quay lại hệ thống, không có API, không có webhook

## 14. Audit & Logging

| Event | Log level | Destination | Fields |
|---|---|---|---|
| Step confirmed | — | `step_executions` | `run_id`, `step_id`, `confirmed_at`, `notes` |
| Evidence captured | — | `step_executions` | `evidence_path`, `captured_at`, `evidence_hash` |
| Run started | — | `runs` | `id`, `procedure_id`, `started_at`, `operator_name` |
| Run finished/cancelled | — | `runs` | `status`, `completed_at` |

Không có file log riêng, không có log level. Toàn bộ dấu vết nằm trong DB. Retention: vô hạn, không có cơ chế dọn dẹp — xem Open Questions.

## 15. Non-functional Requirements

- **Performance**: no timing has been measured yet. The following are the targets to verify before release, not observed values: opening the procedure list returns within 300 ms with 50 procedures of 20 steps each; `export_report` finishes within 5 s for a run carrying 10 embedded images. Every command opens its own SQLite connection and re-runs the schema and migration statements, so the per-call overhead is a fixed cost that grows with neither data volume nor run count.
- **Report size**: a full-screen PNG is typically 0.5–2 MB; base64 adds roughly 33%. A run with 5 evidence images can produce an HTML file of 3–13 MB. This may exceed mail attachment limits. No compression or downscaling is applied.
- **Scalability**: single user, single machine. No concurrency between processes is handled — two instances of the app writing the same database is undefined behaviour.
- **Availability**: fully offline with no external dependency in Phase 1.1. **`[Phase 2]` the split becomes**: running an SOP, capturing evidence, confirming steps, exporting a report to disk and browsing local history keep working without the network as long as a valid local session exists (BR-21 of [`login-report-sharing.md`](login-report-sharing.md)); signing in, listing members and sharing a report require the server. A user with no valid session and no network cannot open the app at all.
- **Platform**: Windows and macOS from the same source tree. Platform-specific behaviour is limited to two places in `lib.rs`: the data directory (`%APPDATA%` vs `~/Library/Application Support`) and the command used to open a URL (`rundll32` vs `open`). Each installer must be built on its own operating system — a Windows machine cannot produce a macOS build. Screen capture on macOS requires the user to grant Screen Recording permission; on Windows no permission prompt exists.
- **Backward compatibility**: existing databases at the platform data directory must keep working. New columns are added with `ALTER TABLE ADD COLUMN` and a default. Tables are never dropped.
- **Accessibility**: not addressed. The window is a compact always-on-top widget with no keyboard navigation contract.

## 16. Edge Cases

### Security
- [ ] Screenshot captures a password or token visible on screen — not handled, operator responsibility
- [ ] Operator replaces the PNG after capture — detectable via `evidence_hash` against the local DB only
- [ ] Operator edits the exported HTML including the hash — **not detectable**

### Timing & State
- [ ] App closed mid-run — the run stays `running`; reopening the app does not offer to resume it
- [ ] Evidence captured but the step never confirmed — the row exists with `confirmed_at` NULL
- [ ] Two runs of the same procedure started in a row — allowed, each has its own UUID

### Data Integrity
- [ ] Step archived while a run is in progress — the run keeps showing it if already executed
- [ ] Evidence folder moved or deleted — export prints a warning line instead of the image
- [ ] `order_index` of archived steps keeps its old value while surviving steps are renumbered — an old report may order steps oddly

### Concurrency
- [ ] Two app instances on the same machine writing the same database — undefined, not handled
- [ ] Same procedure edited while a run of it is in progress — allowed by design

### External Dependencies
- [ ] Multi-monitor machine — only the first screen from `Screen::all()` is captured
- [ ] Screen capture blocked by OS policy or RDP session — command returns an error, step stays blocked

## 17. Test Scenarios

### Happy Path
1. Chọn "Deploy Rails lên EC2" → chạy hết 4 bước, chụp ảnh ở 3 bước bắt buộc → run chuyển `completed` → xuất báo cáo → mở file HTML trên **máy khác** và thấy đủ 3 ảnh

### Edge Cases
1. Bấm "Xác nhận hoàn thành" ở bước bắt buộc khi chưa chụp → hiện đúng message chặn, không ghi `confirmed_at`
2. Chạy 1 SOP tới hoàn thành → sửa quy trình đó (đổi title bước 1, xóa bước 2 đã có ảnh, thêm bước mới) → lưu được, không lỗi FK
3. Tiếp bước 2: mở báo cáo run cũ → bước đã xóa **vẫn hiện** kèm ảnh; bước mới thêm **không** xuất hiện
4. Xóa thủ công file PNG rồi xuất báo cáo → báo cáo vẫn sinh ra, in dòng cảnh báo đúng chỗ
5. Hủy lần chạy giữa chừng → History hiện đúng "Đã hủy", không hiện "Tạm dừng"
6. DB có sẵn run `paused` → mở app → run đó hiện "✕ Đã hủy" trong History, và `SELECT COUNT(*) FROM runs WHERE status='paused'` trả về 0
7. Điền tên "Nguyễn Văn A" trong Settings → chạy 1 SOP → đổi tên thành "Trần Thị B" → xuất báo cáo của run cũ → báo cáo vẫn in "Nguyễn Văn A" (BR-15)
8. Để trống tên trong Settings → chạy 1 SOP → xuất báo cáo → in `(chưa đặt tên)`, không lỗi
9. Run cũ có `evidence_hash` NULL (dữ liệu trước khi nâng cấp) → xuất báo cáo → in `(chưa có hash)`, ảnh vẫn nhúng bình thường
10. Hủy lần chạy → gọi thẳng `confirm_step` và `capture_evidence` trên run đó → cả hai trả đúng message chặn, không ghi gì vào DB, không sinh file PNG (BR-13)
11. Archive 1 quy trình đã có run → quy trình biến mất khỏi Picker, nhưng run cũ vẫn hiện trong History và xuất báo cáo được (BR-14)

### Security Tests
1. Thay file PNG bằng ảnh khác → so `evidence_hash` trong DB với hash tính lại → phát hiện lệch
2. Sửa `confirmed_at` trực tiếp trong DB bằng SQLite browser → **không phát hiện được** (ghi nhận là giới hạn đã biết, không phải test fail)

### Performance Tests
1. Run có 10 bước đều chụp ảnh → đo kích thước file HTML xuất ra, xác nhận có cảnh báo nếu vượt ngưỡng gửi mail thông thường

## 18. Open Questions
- [ ] **Q1 `[ưu tiên cao — Phase 2]`**: Ngưỡng kích thước báo cáo bao nhiêu thì cần cảnh báo hoặc nén ảnh? Từ Phase 2 câu này không còn là tùy chọn: file 3–13 MB phải đi qua mạng và bị chặn bởi giới hạn upload của server lẫn reverse proxy. Liên quan Q5 của [`login-report-sharing.md`](login-report-sharing.md) (cap tạm 25 MB) → Hỏi [PM]
- [ ] Q2: Có cần dọn dẹp ảnh/run cũ sau N tháng không? Hiện dữ liệu tích lũy vô hạn → Hỏi [PM]
- [ ] Q3: Máy nhiều màn hình có phổ biến trong team không? Nếu có thì chụp màn hình nào, hay chụp tất cả? → Hỏi [Dev/PM]
- [ ] Q4: Run bị bỏ dở ở trạng thái `running` khi tắt app — xử lý thế nào? Hiện không có cơ chế nào chạm tới nó → Hỏi [PM]
- [ ] Q5: `order_index` lệch ở báo cáo cũ (mục 16) có chấp nhận được không, hay cần snapshot step theo từng run? → Hỏi [PM]
- [ ] Q6: Run của quy trình đã archive tiếp tục hiện trong History — đã ghi thành BR-14, cần PM xác nhận đây đúng là mong muốn → Hỏi [PM]
- [ ] Q7: Có cần xem lại chi tiết một run đã kết thúc ngay trong app không? Hiện History chỉ có nút xuất HTML, muốn xem phải mở file → Hỏi [PM]

Không câu nào trong Q1–Q7 chặn việc implement Phase 1.1.

## 19. Dependencies & Impact
- **Phụ thuộc vào**: không có module nào khác
- **Ảnh hưởng đến**: Run Execution, Procedure Builder, Report Export, Run History — toàn bộ đều chạm `steps` / `step_executions`
- **Dependency mới cần thêm** (đã được duyệt 2026-08-13): crate `sha2` (tính SHA-256), crate `base64` (nhúng ảnh)
- **Migration cần thiết**: YES, ba câu chạy trong `db()`:
  1. `ALTER TABLE step_executions ADD COLUMN evidence_hash TEXT`
  2. `ALTER TABLE runs ADD COLUMN operator_name TEXT`
  3. `UPDATE runs SET status='cancelled' WHERE status='paused'`

  DB cũ tự nâng cấp khi mở. Dữ liệu cũ có `evidence_hash` và `operator_name` NULL; báo cáo phải xử lý được cả hai trường hợp
- **Breaking change**: YES nhưng đã có đường xử lý. Bỏ trạng thái `paused` khỏi whitelist; run cũ mang giá trị này được migrate sang `cancelled` tự động khi mở DB. Không mất dữ liệu — `started_at`, các bước đã xác nhận và ảnh bằng chứng đều giữ nguyên, chỉ đổi nhãn trạng thái

## 20. Change Log

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-08-13 | Dev | Bản đầu, mô tả as-is + các mục `[SỬA]` đã chốt qua clarify |
| 1.1 | 2026-08-13 | Dev | Fix 2 blocker + 6 warning từ `/nta-spec-review`: thêm `runs.operator_name` (blocker 1); thêm BR-13 chặn ghi vào run đã kết thúc (blocker 2); thêm luồng 8.4 archive quy trình; ghi rõ `list_runs` không lọc archived (BR-14); ghi rõ mọi command đều ghi DB; thay mô tả performance mơ hồ bằng chỉ tiêu đo được; thêm 5 test scenario; thêm bảng nhãn UI 11.1; thêm Q6, Q7 |
| 1.4 | 2026-08-17 | Dev | Mở rộng phạm vi nền tảng sang macOS, không đổi hành vi nghiệp vụ nào: §1 mô tả sản phẩm là desktop Windows **và** macOS; §3 và §12 thay "Windows account" bằng "tài khoản hệ điều hành"; §6 thêm điều kiện thư mục dữ liệu theo từng OS và quyền Screen Recording của macOS; §15 thêm mục **Platform** ghi rõ hai chỗ khác nhau theo OS trong `lib.rs` và việc mỗi bộ cài phải build trên chính OS của nó |
| 1.3 | 2026-08-14 | Dev | Sửa §5.2: `start_run` **bỏ tham số `operatorName`** thay vì "giữ nguyên chữ ký" như v1.2 ghi — nếu frontend còn truyền tên thì mục tiêu chống khai gian không đạt. Ghi rõ đây là chỗ v1.2 nói sai, kèm lý do, để người đọc sau không tưởng là quyết định bị đổi vô cớ. Các mục `[Phase 2]` khác của v1.2 vẫn đúng |
| 1.2 | 2026-08-14 | Dev | Đồng bộ với `login-report-sharing.md` v1.0 theo §22 của tài liệu đó. Không đổi hành vi nào đang chạy — chỉ gỡ các khẳng định nay đã sai và đánh dấu `[Phase 2]` cho phần bị thay đổi: §1 bỏ "chạy offline" khỏi mô tả sản phẩm và thêm phạm vi tài liệu; §3 bổ sung Admin/Member; §5.2 `start_run` đổi nguồn `operatorName`; §6 thêm điều kiện đã đăng nhập; §10 BR-15 được BR-23 thay thế; §12 viết lại Authentication/Authorization/Rate limiting và thêm Data in transit; §15 tách rõ phần offline và phần cần server; §18 nâng ưu tiên Q1; §21 chuyển "định danh người dùng tập trung" từ ngoài scope vào Phase 2. Phase 1 + 1.1 được ghi nhận là **đã implement** |

---

## 21. Tóm tắt xác nhận *(nội bộ — xóa trước khi gửi khách hàng)*

**Tính năng:** SOP Widget — chạy quy trình vận hành có ảnh bằng chứng, xuất báo cáo HTML gửi leader

**Mục đích:** Kỹ sư vận hành không nhảy sót bước khi làm việc rủi ro, và có bằng chứng gửi lại cho leader

**Cần team xác nhận:**
- [ ] BR-06: báo cáo của run đã xong chỉ hiện bước đã thực hiện — bước thêm sau không lọt vào
- [x] BR-08 + BR-12 + mục 11: bỏ hẳn `paused`, tạm dừng = hủy; dữ liệu cũ tự migrate sang `cancelled` — **đã chốt 2026-08-13**
- [x] Cột mới `evidence_hash` và 2 crate `sha2` + `base64` — **đã duyệt 2026-08-13**
- [ ] Mục 12: hash **không** làm báo cáo đáng tin với bên thứ ba — cần leader hiểu đúng điều này
- [ ] BR-14: archive quy trình không giấu run cũ khỏi History — xác nhận đúng mong muốn
- [x] BR-15: tên người thực hiện chốt tại lúc bắt đầu chạy, đổi Settings sau không ảnh hưởng run cũ — **Phase 2 thay nguồn tên bằng tài khoản đăng nhập (BR-23), cơ chế chốt-tại-`start_run` giữ nguyên**
- [ ] Q1–Q7 ở mục 18 chưa có câu trả lời

**Ảnh hưởng phần khác:** toàn bộ 4 module chính đều chạm `steps` / `step_executions`; đây là spec đầu tiên của project nên không có spec nào khác bị lệch

**Không nằm trong scope lần này:**
- Phân phối SOP tập trung cho team — mỗi máy giữ bản riêng
- ~~Định danh người dùng tập trung~~ → **đã chuyển vào scope Phase 2 theo yêu cầu của PM ngày 2026-08-14**. Quyết định "chỉ có ô tên tự nhập trong Settings" của ngày 2026-08-13 bị lật; owner: PM. Đặc tả tại [`login-report-sharing.md`](login-report-sharing.md), quá trình làm rõ tại [`../clarify/clarify_login-report-sharing.md`](../clarify/clarify_login-report-sharing.md)
- Đồng bộ **ảnh bằng chứng gốc** lên server — Phase 2 chỉ đưa file HTML đã nhúng base64 lên server, thư mục `evidence/` vẫn nằm ở máy
- Chống can thiệp mức B / C / D
- Snapshot step theo từng run
