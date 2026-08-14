import 'dotenv/config';
import { resolve } from 'node:path';

// Toàn bộ thời gian trong hệ thống là UTC (§4.2). Đặt lại ở đây để không phụ thuộc
// vào cấu hình của máy chạy — sai điểm này làm sessions.expires_at hết hạn lệch giờ.
process.env.TZ = 'UTC';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường bắt buộc: ${name}`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Biến môi trường ${name} phải là số dương.`);
  return value;
}

export const config = {
  port: number('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: number('DB_PORT', 3306),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database: required('DB_NAME')
  },
  storageDir: resolve(process.env.STORAGE_DIR ?? './storage/reports'),
  sessionTtlDays: number('SESSION_TTL_DAYS', 30),
  maxUploadBytes: number('MAX_UPLOAD_MB', 25) * 1024 * 1024,
  maxUploadMb: number('MAX_UPLOAD_MB', 25),
  loginRateLimit: number('LOGIN_RATE_LIMIT', 10),
  loginRateWindowMinutes: number('LOGIN_RATE_WINDOW_MINUTES', 15),
  seedAdmin: {
    username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    displayName: process.env.SEED_ADMIN_DISPLAY_NAME ?? 'Quản trị viên',
    password: process.env.SEED_ADMIN_PASSWORD ?? ''
  }
} as const;

export const SESSION_COOKIE = 'sop_session';
