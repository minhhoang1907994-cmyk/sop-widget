-- Chạy một lần khi container MySQL được khởi tạo lần đầu (volume còn trống).
-- Test tích hợp xóa sạch bảng trong beforeEach nên phải có database riêng, không dùng
-- chung với database dev.
CREATE DATABASE IF NOT EXISTS sop_widget_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON sop_widget_test.* TO 'sop'@'%';
FLUSH PRIVILEGES;
