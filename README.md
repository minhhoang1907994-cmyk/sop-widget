# SOP Widget

Ứng dụng desktop (Windows và macOS) để tạo và chạy SOP theo từng bước, lưu lịch sử local và ảnh bằng chứng.

## Tính năng MVP

- Tạo, sửa, nhân bản và ẩn SOP; mỗi SOP có các bước, lệnh tham khảo và cờ bắt buộc ảnh bằng chứng.
- Chạy SOP theo từng bước; không thể xác nhận bước bắt buộc khi chưa chụp ảnh.
- Chụp toàn màn hình, lưu bằng chứng theo lần chạy.
- Lưu SQLite local, tự seed ba SOP mẫu Deploy, Backup và Setup server.
- Xem lịch sử và xuất báo cáo HTML chứa bước, thời gian, ghi chú và đường dẫn ảnh bằng chứng.

## Chạy phát triển

Windows (script `tauri:win` tự set biến môi trường Rust của máy dev):

```powershell
npm.cmd install
npm.cmd run tauri:win dev
```

macOS (cần Xcode Command Line Tools cho `rusqlite` bundled):

```bash
xcode-select --install
npm install
npm run tauri dev
```

## Đóng gói

```powershell
npm.cmd run tauri:win build   # Windows → installer NSIS
```

```bash
npm run tauri build           # macOS → .app và .dmg
```

Kết quả nằm trong `src-tauri/target/release/bundle`. Bản macOS build ra kiến trúc của chính
máy build; muốn chạy cả máy Intel lẫn Apple Silicon thì thêm `--target universal-apple-darwin`
(phải `rustup target add x86_64-apple-darwin aarch64-apple-darwin` trước).

Lần đầu chụp ảnh bằng chứng trên macOS, cấp quyền **System Settings → Privacy & Security →
Screen Recording** cho ứng dụng, nếu không thao tác chụp sẽ báo lỗi.

## Dữ liệu local

Windows:

- SQLite: `%APPDATA%\NTA\SOP Widget\sop-widget.db`
- Ảnh bằng chứng: `%APPDATA%\NTA\SOP Widget\evidence`
- Báo cáo HTML: `%APPDATA%\NTA\SOP Widget\reports`

macOS:

- SQLite: `~/Library/Application Support/NTA/SOP Widget/sop-widget.db`
- Ảnh bằng chứng: `~/Library/Application Support/NTA/SOP Widget/evidence`
- Báo cáo HTML: `~/Library/Application Support/NTA/SOP Widget/reports`

App không tự thực thi lệnh hay SSH vào server; các lệnh chỉ là hướng dẫn hiển thị cho người thực hiện.
