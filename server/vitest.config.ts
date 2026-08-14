import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test tích hợp xóa sạch bảng trong beforeEach, nên **bắt buộc** chạy trên database riêng.
    // Nếu để trỏ vào DB dev thì mỗi lần chạy test là mất toàn bộ dữ liệu đang dùng, kể cả
    // tài khoản admin đã seed.
    //
    // `dotenv` trong src/config.ts không ghi đè biến đã có sẵn, nên hai giá trị dưới đây
    // luôn thắng giá trị trong .env.
    env: {
      DB_NAME: 'sop_widget_test',
      LOG_LEVEL: 'silent'
    },
    // Dùng chung một database nên các file test không được chạy song song.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
