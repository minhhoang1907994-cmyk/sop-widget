# Clarification Report — SOP Widget (as-is)

**Ngày**: 2026-08-13 | **Người yêu cầu**: Dev (chủ project)
**Scope**: tài liệu hóa app đang có, không thiết kế tính năng mới
**Version**: 1.1 — đã có câu trả lời cho toàn bộ BLOCKER

---

## ✅ Đã rõ — verify từ source

| Điểm | Nguồn |
|---|---|
| Mục đích: chạy SOP từng bước, ép chụp ảnh bằng chứng ở bước bắt buộc | `README:5-11`, `lib.rs:87` |
| Kiến trúc: React SPA → Tauri IPC → 10 command → SQLite local. Không server, không auth, không mạng | `api.ts:4-15`, `lib.rs:103` |
| 4 bảng: `procedures`, `steps`, `runs`, `step_executions` | `lib.rs:31-34` |
| 5 view: picker / runner / done / builder / history | `App.tsx:6` |
| Ranh giới: không thực thi lệnh, không SSH | `README:38` |
| Lưu trữ: `%APPDATA%\NTA\SOP Widget` (db + evidence + reports) | `lib.rs:22-27` |
| Run status: `running` / `paused` / `completed` / `cancelled`, có whitelist | `lib.rs:89` |
| Soft delete: `procedures.archived`, `steps.archived` | `lib.rs:36-37` |

## ✅ Đã rõ — do user trả lời (2026-08-13)

| # | Câu hỏi | Câu trả lời |
|---|---|---|
| 1 | Ai đọc bằng chứng | Người vận hành tự xem lại **+ gửi file HTML cho Leader / auditor / khách hàng** |
| 2 | Chống can thiệp | **Có, bắt buộc** — chọn mức A (hash SHA-256 lưu DB, in lên báo cáo) |
| 3 | 4 bất thường | Sửa lại cho hợp lý |
| 4 | Ngữ nghĩa `paused` | Tạm dừng = **thoát hẳn khỏi quy trình**, không chạy tiếp |
| 5 | Phạm vi người dùng | Toàn bộ thành viên team, **mỗi người cài riêng, không đồng bộ** |
| 6 | Định dạng báo cáo | HTML nhúng ảnh base64, một file |
| 7 | Phân phối SOP + định danh tập trung | Không làm — ghi là giới hạn đã biết |
| 8 | Tên người thực hiện | Thêm ô nhập trong Settings, lưu `localStorage`, in lên đầu báo cáo |
| 9 | Nút "‹ Bước trước" | Bỏ hẳn |
| 10 | Dependency `sha2` + `base64` | Duyệt |
| 11 | Run cũ mang status `paused` | Migrate tự động sang `cancelled` khi mở DB |

---

## 🔎 Bốn bất thường đã verify — tất cả đưa vào scope sửa

| # | Phát hiện | Bằng chứng | Hướng sửa đã chốt |
|---|---|---|---|
| 1 | Run `paused` không chạy tiếp được — History chỉ có nút "Xuất HTML" | `App.tsx:128` | Bỏ `paused`, nút đổi nhãn "Hủy lần chạy", set `cancelled` |
| 2 | Nút "‹ Bước trước" không có `onClick` — bấm không làm gì | `App.tsx:118` | Bỏ hẳn nút |
| 3 | `delete_procedure` không được UI gọi ở bất kỳ đâu | grep `App.tsx`: không có `deleteProcedure` | Thêm nút xóa quy trình vào Builder |
| 4 | History hiển thị sai trạng thái — mọi status khác `completed` đều hiện "⏸ Tạm dừng" | `App.tsx:128` | Hiển thị đúng 3 trạng thái |

---

## 🔴 Hai vấn đề nghiêm trọng phát sinh từ chính câu trả lời

### B1. File HTML gửi đi hiện không xem được ảnh bằng chứng

Báo cáo hiện chèn đường dẫn ảnh dưới dạng **chữ thuần** trong ô bảng, không phải thẻ `<img>` (`lib.rs:100`). Ảnh nằm ở `%APPDATA%` trên máy người chạy.

Leader/auditor mở file HTML nhận được sẽ thấy dòng chữ đường dẫn và **không mở được ảnh nào**. Mục đích "gửi cho người khác xem" hiện **không hoạt động** — đây là chức năng đang hỏng so với mục đích thật, không phải cải tiến.

**Đã chốt**: nhúng base64, một file duy nhất.

### B2. Mức A không làm báo cáo đáng tin với bên thứ ba

Người dùng đã chọn mức A sau khi xem bảng so sánh 4 mức. Cần ghi lại rõ giới hạn thật để không ai hiểu nhầm:

- Hash được in trong chính file HTML mà người vận hành gửi đi → họ sửa được cả ảnh lẫn hash trong cùng file đó
- Với người nhận, hash chỉ có giá trị khi có nguồn đối chiếu độc lập — ở đây không có
- **Giá trị thật của mức A**: phát hiện ảnh bị thay trên máy người vận hành khi có người kiểm tra lại DB gốc, và phát hiện file hỏng
- **Không đạt được**: làm báo cáo gửi đi trở nên đáng tin với auditor

Bảng so sánh đã trình bày khi ra quyết định:

| Mức | Cách làm | Chống được | Không chống được |
|---|---|---|---|
| A (đã chọn) | Hash SHA-256 ảnh lúc chụp, lưu DB, in lên báo cáo | Thay ảnh sau khi chụp | Người dùng sửa cả DB lẫn báo cáo |
| B | A + hash móc xích giữa các bước | Sửa lẻ một bước | Làm lại toàn bộ chuỗi |
| C | B + ký số bằng khóa không nằm trên máy người dùng | Gần như mọi sửa đổi cục bộ | Cần hạ tầng quản lý khóa |
| D | Đẩy bằng chứng lên server ngay khi chụp | Mọi sửa đổi cục bộ | Không còn là app offline |

### B3. Team dùng chung nhưng dữ liệu hoàn toàn cục bộ — chấp nhận

Mỗi máy một file DB riêng (`lib.rs:29`). Hệ quả **đã được chấp nhận, không xử lý trong phase này**:
- Leader sửa SOP → thành viên khác không nhận được bản mới, mỗi người có thể chạy phiên bản khác nhau
- Không có trường ghi ai thực hiện trong bảng `runs` — bù bằng ô tên tự nhập trong Settings

---

## ⚠️ Impact Scan

| Module | Liên quan | Rủi ro | Cần làm |
|---|---|---|---|
| Run Execution | `steps` + `step_executions`; chặn xác nhận khi thiếu ảnh | HIGH | Test regression sau bản fix FK `374a50c` |
| Procedure Builder | Vừa đổi sang soft delete step | HIGH | Test sửa quy trình đã chạy |
| Report Export | Đọc qua `get_run` → `procedure_scoped` | HIGH | Verify báo cáo cũ giữ đúng bước; đổi sang base64 |
| Run History | Đọc `runs` + đếm `step_executions` | MEDIUM | Sửa hiển thị status (bất thường #4) |
| Evidence Capture | Ghi file + `evidence_path` | MEDIUM | Thêm tính hash; đổi thư mục vẫn làm mất liên kết ảnh |
| Widget Settings | `localStorage`, độc lập | LOW | Thêm ô tên người thực hiện |

> Toàn bộ module chưa có spec trước đây — đây là spec đầu tiên của project.

---

## 📋 Bắt buộc xuất ra

### TOP 3 điểm dễ bị bỏ sót
1. File HTML gửi đi không có ảnh — phá hỏng chính mục đích của app, phát hiện muộn thì leader đã nhận file vô dụng
2. Ảnh bằng chứng lưu dạng đường dẫn text; đổi thư mục là hỏng liên kết
3. `order_index` của step đã archive giữ giá trị cũ → báo cáo cũ có thể sắp sai thứ tự

### TOP 3 cần xác nhận với khách hàng
1. Bằng chứng dùng để đối chiếu nội bộ hay chứng minh với bên ngoài? → **đã trả lời: gửi ra ngoài cho leader/auditor**
2. Chấp nhận việc người vận hành có thể sửa/xóa bằng chứng của chính mình không? → **đã chọn mức A, tức là chỉ phát hiện được một phần**
3. Có cần tập trung SOP cho cả team không? → **đã trả lời: không, mỗi người một bản**

### File cần đọc trước khi implement
- `src-tauri/src/lib.rs` — toàn bộ backend, schema và 10 command
- `src/App.tsx` — toàn bộ UI, 5 view, nơi có 4 bất thường
- `src/types.ts` + `src/api.ts` — ranh giới IPC
- `CLAUDE.md` — conventions đã chốt
- `.memory/HANDOFF.md` — bối cảnh bản fix FK `374a50c`
- `docs/spec/sop-widget.md` — spec sinh ra từ chính clarify này

### Cần trao đổi với PM
- Mức A chỉ phát hiện được một phần can thiệp. Nếu sau này auditor yêu cầu bằng chứng có giá trị đối chứng thật thì phải nâng lên mức C hoặc D — đây là thay đổi kiến trúc, không phải cải tiến nhỏ
- Kích thước báo cáo nhúng base64 có thể vượt giới hạn đính kèm mail (3–13 MB cho run 5 ảnh)

### Điểm nguy hiểm nếu tiến hành với yêu cầu hiện tại
- Chưa ai dùng thật app này (chưa xác nhận) → spec dựa một phần trên phỏng đoán về nhu cầu thực tế
- Bản fix FK `374a50c` mới verify ở mức SQLite + compile, **chưa chạy app thật** — spec mô tả hành vi chưa được kiểm chứng end-to-end
- Nếu spec bị đọc là "app chống can thiệp" thì kỳ vọng sai hoàn toàn so với mức A

### Theo tiêu chuẩn chất lượng NTA
- **Tuân thủ deadline**: không có deadline — không đánh giá được
- **Giảm sai sót**: 4 bất thường đã được phân loại và có hướng sửa, không còn là nguồn sai sót mở
- **Không gây khó khăn cho công đoạn sau**: bỏ `paused` là breaking change nhưng đã có migration một chiều, không để trạng thái mồ côi
- **Ngăn ngừa tái phát**: defect FK đã ghi vào HANDOFF + CLAUDE.md; ràng buộc "cấm DELETE FROM steps" đã thành business rule BR-02
- **Có thể giải trình**: các quyết định ngày 2026-08-13 đều ghi lại trong file này kèm người quyết định; chưa có xác nhận từ leader hay khách hàng

---

## 🚀 Bước tiếp theo
1. Không còn BLOCKER — spec đã soạn tại `docs/spec/sop-widget.md`
2. Chạy `/nta-spec-review` để review spec
3. Sau đó `/nta-implement` cho Phase 1.1
4. Q1–Q5 trong spec cần hỏi PM nhưng không chặn implement
