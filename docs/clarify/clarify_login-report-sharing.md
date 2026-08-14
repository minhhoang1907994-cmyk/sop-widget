# Clarification Report — Login + chia sẻ báo cáo qua server

**Ngày**: 2026-08-14
**Người yêu cầu**: PM (cần bổ sung tên cụ thể + ngày yêu cầu để ghi vào change log spec v2.0)
**Yêu cầu ban đầu**: *"thêm chức năng login, nếu login với quyền admin thì có thêm button tạo tài khoản"*
**Trạng thái**: không còn BLOCKER — sẵn sàng chạy `/nta-spec-write` ra spec v2.0
**Số vòng clarify**: 5

---

## 0. Tóm tắt điều đã thay đổi so với yêu cầu ban đầu

Yêu cầu ban đầu mô tả một giải pháp ("thêm login", "thêm button"). Sau 5 vòng làm rõ, bản chất
công việc là **mở rộng sản phẩm từ desktop offline sang client–server**:

- Không chỉ là màn hình login — cần một **Backend API mới hoàn toàn** (chưa tồn tại).
- Mục đích chính của login **không phải** bảo vệ dữ liệu local, mà để **định danh người gửi/nhận
  báo cáo qua server**.
- Vấn đề nghiệp vụ gốc: **định danh người thực hiện, chống khai tên giả** (hiện tên người thực
  hiện là ô text tự nhập trong Settings, `src/App.tsx:90`).

Yêu cầu này **đảo ngược quyết định đã chốt ngày 2026-08-13** ghi tại `docs/spec/sop-widget.md`
mục 3 (*"App không có cơ chế đăng nhập hay phân quyền"*) và mục 21 (*"Định danh người dùng tập
trung"* nằm ngoài scope). Owner của việc lật quyết định: PM.

---

## 1. Đã rõ — quyết định nghiệp vụ đã chốt

| # | Quyết định | Vòng chốt |
|---|---|---|
| 1 | Member lưu ở **DB server** (không phải SQLite local từng máy) | 3 |
| 2 | Sau khi hoàn thành quy trình, file HTML báo cáo **lưu trên server**, chia sẻ bằng **link** | 4 |
| 3 | **Link yêu cầu đăng nhập** — server kiểm tra phiên trước khi cho xem | 5 |
| 4 | Quyền xem ảnh bằng chứng: **chỉ người gửi + người nhận + admin** | 3 |
| 5 | **Chọn member ngay trong app** — server ghi nhận người nhận; member thấy trong danh sách báo cáo nhận được | 5 |
| 6 | **Backend API do Dev (Claude) viết** | 5 |
| 7 | Giai đoạn hiện tại chạy **Docker local**; server `http://54.178.76.191/` triển khai sau | 4 |
| 8 | Bootstrap: **seed sẵn 1 admin** trên server → admin login → tạo member | 2 |
| 9 | Quên mật khẩu: member → admin cấp lại; admin → người phụ trách server sửa DB trực tiếp | 2, 3 |
| 10 | Vấn đề gốc: định danh người thực hiện, chống khai tên giả | 2 |

### 1.1 Hành vi khi mất mạng (chốt vòng 4)

| Tình huống | Hành vi |
|---|---|
| Chưa login | Không login được, hiện thông báo |
| Đã login | **Giữ nguyên phiên**, dùng app bình thường |
| Gửi báo cáo | Không gửi được; vẫn lưu file HTML ở máy mình |

### 1.2 Stack backend (chốt vòng 5)

| Hạng mục | Lựa chọn |
|---|---|
| Ngôn ngữ / framework | **Node.js + TypeScript** (Fastify hoặc Express) |
| Database server | **MySQL / MariaDB** |
| Vị trí code | **Cùng repo**, thư mục `server/` |

---

## 2. Quyết định thiết kế D1–D7 (Dev đề xuất, PM ủy quyền vòng 4)

PM đã ủy quyền: *"còn lại hãy tự xem xét hệ thống và đưa ra quyết định đúng nhất"*.

| # | Quyết định | Lý do |
|---|---|---|
| D1 | `procedures`, `steps`, `runs`, `step_executions` và ảnh PNG gốc **giữ nguyên ở SQLite local**, không đồng bộ lên server | App phải chạy được khi mất mạng (mục 1.1); giữ nguyên 4 bảng và 10 command hiện có, tương thích ngược với DB user đang dùng (quy tắc project #5) |
| D2 | Server chỉ chứa **member** và **báo cáo** (file HTML + metadata: người gửi, người nhận, thời điểm, run_id) | Đúng phạm vi PM nêu; giữ backend nhỏ nhất có thể |
| D3 | **Không upload ảnh PNG riêng** lên server — ảnh đã nhúng base64 trong chính file HTML | Đúng BR-10 hiện có (`src-tauri/src/lib.rs:190-198`); tránh kho ảnh thứ hai phải phân quyền riêng |
| D4 | `export_report` **luôn ghi file ra máy local trước** (giữ hành vi hiện tại, `lib.rs:182-186`), sau đó mới upload nếu có mạng | Mất mạng vẫn có file trong tay; không mất dữ liệu khi upload lỗi |
| D5 | **Bỏ ô "Tên người thực hiện" tự nhập** trong Settings (`src/App.tsx:90`), lấy tên từ tài khoản đã login. BR-15 (spec mục 10) phải viết lại | Vấn đề gốc là chống khai tên giả — giữ ô tự nhập thì mục tiêu không đạt. **Cần PM xác nhận trước release** (quyết định nghiệp vụ) |
| D6 | Token đăng nhập lưu bền trên máy, **hạn 30 ngày**; hết hạn mà không có mạng thì không gia hạn được | Hệ quả trực tiếp của "đã login thì giữ nguyên"; không đặt con số sẽ thành phiên vô thời hạn. **Cần PM xác nhận trước release** |
| D7 | Run cũ trong DB (chưa gắn tài khoản) vẫn xem và xuất báo cáo local bình thường; muốn chia sẻ thì gắn tài khoản đang login tại thời điểm gửi | Không phá dữ liệu cũ, không cần migrate |

---

## 3. Điều kiện bắt buộc trước khi deploy lên server thật

Không chặn giai đoạn phát triển với Docker local.

- [ ] **HTTPS hoặc giới hạn VPN cho `54.178.76.191`.** Hiện là `http://` trên IP công cộng.
      Mật khẩu, token phiên và file HTML chứa ảnh chụp màn hình sẽ truyền **không mã hóa**.
      Spec mục 12 đã ghi rõ ảnh bằng chứng có thể chứa credential, token, dữ liệu khách hàng.
      Cấp chứng chỉ cho IP thuần rất hạn chế → cần domain, hoặc đặt server sau VPN.
      → Hỏi [PM + người phụ trách server]
- [ ] Áp dụng rule `nta-prod-safety` khi triển khai: tài khoản test và báo cáo test phải có marker
      nhận diện được, dọn ngay trong cùng session, không dùng tài khoản người thật.

---

## 4. IMPORTANT còn mở — trả lời trong lúc viết spec, không chặn

- [ ] Server giữ file HTML bao lâu, ai backup, dung lượng dự kiến? Mỗi file **3–13 MB**, không nén
      (spec mục 15). Nối với Q1, Q2 đang mở ở spec mục 18 → Hỏi [PM]
- [ ] Kiểm quyền xem báo cáo **phải nằm ở server**, không phải ẩn nút trong `App.tsx` → Xác nhận [PM]
- [ ] Gửi được cho nhiều member cùng lúc không? Có đánh dấu đã đọc / thông báo báo cáo mới không? → Hỏi [PM]
- [ ] Member nghỉ việc: xóa cứng hay soft delete theo pattern `archived` đã dùng ở `procedures`/`steps`?
      Báo cáo đã gửi cho họ xử lý sao? → Hỏi [PM]
- [ ] Ma trận quyền đầy đủ: ngoài "tạo tài khoản", admin và member còn khác nhau ở tạo/sửa/xóa
      quy trình, xem History của người khác? → Hỏi [PM]
- [ ] Logout khi đang có run `running` → hủy, giữ nguyên, hay chặn logout? → Hỏi [PM]
- [ ] Tên người phụ trách server + SLA reset mật khẩu admin → Hỏi [PM]
- [ ] Môi trường Docker gồm những gì — chỉ MySQL, hay cả backend? → Chốt khi dựng
- [ ] **Dependency mới cần duyệt** (quy tắc project #7):
      - Phía app: HTTP client (`@tauri-apps/plugin-http` hoặc crate `reqwest`)
      - Phía server: Fastify/Express, MySQL driver, `argon2` hoặc `bcrypt`, thư viện xử lý upload
      - `sha2` (`src-tauri/Cargo.toml:23`) đang dùng cho hash ảnh — **không dùng cho mật khẩu**
- [ ] Thêm permission network vào `src-tauri/capabilities/default.json` (hiện chỉ có 4 permission window)

### NICE-TO-KNOW (assumption tạm)

- Thu hồi báo cáo đã gửi → **không**
- Gửi lại cùng một run lần hai → tạo bản mới, theo cách `export_report` sinh file mới theo timestamp (`lib.rs:184`)
- Số role → đúng 2: admin và member
- Log audit lần đăng nhập / lần mở báo cáo trên server → **có**, vì liên quan quyền xem ảnh bằng chứng

---

## 5. Impact Scan — module bị ảnh hưởng

| Module / File | Liên quan thế nào | Rủi ro | Cần làm gì |
|---|---|---|---|
| **`server/` (chưa tồn tại)** | Auth, quản lý member, nhận file, phân quyền, phát link | HIGH | Khối lượng lớn nhất của cả feature |
| `src-tauri/capabilities/default.json:6-11` | Chỉ có 4 permission window, không có network | HIGH | Thêm permission HTTP |
| `src-tauri/Cargo.toml` / `package.json` | Chưa có HTTP client | HIGH | Duyệt dependency mới |
| `export_report` (`src-tauri/src/lib.rs:161-187`) | Điểm nối upload; file 3–13 MB | HIGH | Thêm timeout, retry, xử lý offline (D4) |
| 10 command + `generate_handler!` (`lib.rs:202`) | Thêm command login/logout/list member/upload/list báo cáo nhận | HIGH | Mỗi command mới phải đăng ký, kèm wrapper `src/api.ts` + type `src/types.ts` (quy tắc #4) |
| `src/App.tsx:6` — union `View` | Thêm view login + view báo cáo nhận được | HIGH | Không có router, mở rộng union hiện có |
| Settings — ô tên tự nhập (`src/App.tsx:90`) + BR-15 | Bị thay bằng tài khoản login (D5) | HIGH | Sửa spec mục 10 |
| Ảnh bằng chứng (nhúng base64 trong HTML) | Rời khỏi máy, lên server | HIGH | Phân quyền ở server |
| `docs/spec/sop-widget.md` mục 1, 3, 10, 12, 13, 15, 19, 21 | Nhiều chỗ khẳng định offline / không login / no external dependency | HIGH | Ra spec v2.0, không vá vào v1.1 |
| `CLAUDE.md` — Tech Stack, Cấu trúc thư mục, "không Docker, không CI" | Sai sau thay đổi này | HIGH | Viết lại; bổ sung convention cho boundary HTTP |
| `.gitignore` | `server/node_modules/` chưa được loại trừ | MEDIUM | Bổ sung **trước** commit đầu tiên của `server/` |
| `docs/diagram/` (4 file) | Chưa có login, server, luồng chia sẻ | MEDIUM | Vẽ lại sau khi chốt spec |
| Phase 1.1 còn dở (4 bất thường UI, Q1–Q7 spec mục 18) | Cạnh tranh nguồn lực | MEDIUM | PM quyết thứ tự ưu tiên |

---

## 6. TOP 3 điểm dễ bị bỏ sót nguy hiểm nhất

1. **Bỏ ô tên tự nhập (D5)** — nếu quên, mục tiêu gốc "chống khai tên giả" không đạt dù login đã
   chạy đúng. Báo cáo sẽ có hai nguồn "ai thực hiện" mâu thuẫn nhau.
2. **Thời hạn phiên khi offline (D6)** — không đặt con số cụ thể thì thành phiên vô thời hạn,
   login mất ý nghĩa.
3. **Kiểm quyền xem báo cáo đặt sai chỗ** — ẩn nút trong `App.tsx` là cách dễ nhất và sai nhất;
   gọi thẳng API là lấy được. Quy tắc "chỉ người gửi + người nhận + admin" phải enforce ở server.

## 7. TOP 3 điều cần xác nhận trước với PM

1. **D5** — bỏ ô "Tên người thực hiện" tự nhập, lấy tên từ tài khoản login (thay đổi nghiệp vụ,
   kéo theo viết lại BR-15).
2. **D6** — token 30 ngày; hết hạn khi offline thì không gia hạn được.
3. **HTTPS/VPN** trước ngày deploy lên `54.178.76.191`, kèm chi phí domain/chứng chỉ.

## 8. File cần đọc trước khi implement

| File | Lý do |
|---|---|
| `docs/spec/sop-widget.md` mục 1, 3, 10 (BR-15), 12, 13, 15, 21 | Mọi chỗ khẳng định offline / không auth, phải sửa đồng bộ |
| `src-tauri/src/lib.rs:24-47` | `app_dir()` và `db()` — nơi duy nhất tạo schema và chạy `ALTER TABLE` |
| `src-tauri/src/lib.rs:161-187` | `export_report` — điểm nối luồng upload |
| `src-tauri/src/lib.rs:202` | `generate_handler!` — quên đăng ký sẽ lỗi runtime, không lỗi compile |
| `src-tauri/capabilities/default.json` | Permission network phải mở |
| `src/api.ts`, `src/types.ts` | Wrapper duy nhất quanh `invoke()`; sửa cùng lúc (quy tắc #4) |
| `src/App.tsx:6`, `:19-38`, `:90` | Union `View`, state/localStorage, ô tên sẽ bỏ |
| `.memory/HANDOFF.md` mục "Quyết định thiết kế cần giữ" | Các quyết định quá khứ không được tự đổi |

## 9. Luận điểm cần trao đổi với PM

- Đây là **mở rộng sản phẩm sang client–server**, không phải feature nhỏ. Nên tách hạng mục và
  ước tính riêng cho phần `server/`.
- Chi phí thật gồm: hạ tầng server, domain + chứng chỉ HTTPS, dung lượng lưu trữ, backup,
  người vận hành, môi trường test.
- Cần duyệt 2 nhóm dependency mới (phía app và phía server).
- Q1 spec mục 18 (ngưỡng kích thước báo cáo) từ "không cấp thiết" thành **cần trả lời**, vì file
  3–13 MB nay phải đi qua mạng.
- Phase 1.1 còn 4 bất thường UI chưa sửa và Q1–Q7 chưa trả lời — cần quyết làm trước hay sau.

## 10. Điểm nguy hiểm nếu tiến hành mà không đọc tài liệu này

- **Chưa verify được `http://54.178.76.191/` đang chạy gì** — repo không có tham chiếu nào tới địa
  chỉ này. Mọi thiết kế tích hợp dựa trên giả định về nó đều chưa có căn cứ.
- Assumption ngầm *"link chỉ người được gửi mới có"* — link luôn có thể forward; đây chính là lý do
  chốt phương án link-yêu-cầu-đăng-nhập.
- Assumption ngầm *"server nội bộ nên không cần mã hóa"* — không đúng với IP công cộng.
- Mâu thuẫn trực tiếp với spec v1.1 mục 15 (*fully offline, no external dependency*) và với
  `CLAUDE.md`.

## 11. Điểm còn thiếu theo tiêu chuẩn chất lượng NTA

| Tiêu chí | Đánh giá |
|---|---|
| Tuân thủ deadline | Chưa có deadline; chưa ước tính được cho tới khi chốt phạm vi API và schema server |
| Giảm sai sót | Hai nguồn định danh người thực hiện (D5) là nguồn sai sót lớn nhất còn lại |
| Không gây khó khăn cho công đoạn sau | Retention và backup trên server phải chốt **trước** khi có dữ liệu thật |
| Ngăn ngừa tái phát | Tiền lệ trong chính project: `evidence_hash` (spec mục 12) được chốt khi chưa hiểu đúng mức bảo đảm. Lần này đã tránh lặp lại bằng cách chốt link-yêu-cầu-đăng-nhập thay vì link công khai |
| Có thể giải trình trách nhiệm | Còn thiếu: tên PM + ngày yêu cầu, tên người phụ trách server. Cần bổ sung vào change log spec v2.0 |

---

## 12. Bước tiếp theo

1. Chạy `/nta-spec-write` → **spec v2.0** (không vá vào v1.1).
2. Cập nhật `CLAUDE.md`: Tech Stack, Cấu trúc thư mục, convention cho boundary HTTP, gỡ mô tả
   "offline" và "không Docker, không CI".
3. Bổ sung `server/node_modules/` vào `.gitignore` trước commit đầu tiên của `server/`.
4. Vẽ lại `docs/diagram/` sau khi spec v2.0 được duyệt.

---

## 13. Change log

| Version | Ngày | Nội dung |
|---|---|---|
| 1.0 | 2026-08-14 | Bản đầu, tổng hợp 5 vòng clarify. Không còn BLOCKER |
