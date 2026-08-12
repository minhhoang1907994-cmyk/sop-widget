# SOP Widget

Ứng dụng desktop Windows để tạo và chạy SOP theo từng bước, lưu lịch sử local và ảnh bằng chứng.

## Tính năng MVP

- Tạo, sửa, nhân bản và ẩn SOP; mỗi SOP có các bước, lệnh tham khảo và cờ bắt buộc ảnh bằng chứng.
- Chạy SOP theo từng bước; không thể xác nhận bước bắt buộc khi chưa chụp ảnh.
- Chụp toàn màn hình, lưu bằng chứng theo lần chạy.
- Lưu SQLite local, tự seed ba SOP mẫu Deploy, Backup và Setup server.
- Xem lịch sử và xuất báo cáo HTML chứa bước, thời gian, ghi chú và đường dẫn ảnh bằng chứng.

## Chạy phát triển

```powershell
npm.cmd install
$env:RUSTUP_HOME = "$env:USERPROFILE\.rustup"
$env:CARGO_HOME = "$env:USERPROFILE\.cargo"
npm.cmd run tauri dev
```

## Đóng gói Windows

Sau khi Rust và Microsoft C++ Build Tools đã sẵn sàng:

```powershell
npm.cmd run tauri build
```

Installer được tạo trong `src-tauri\target\release\bundle`.

## Dữ liệu local

- SQLite: `%APPDATA%\NTA\SOP Widget\sop-widget.db`
- Ảnh bằng chứng: `%APPDATA%\NTA\SOP Widget\evidence`
- Báo cáo HTML: `%APPDATA%\NTA\SOP Widget\reports`

App không tự thực thi lệnh hay SSH vào server; các lệnh chỉ là hướng dẫn hiển thị cho người thực hiện.
