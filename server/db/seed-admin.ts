import { hashPassword } from '../src/auth/service.js';
import { config } from '../src/config.js';
import { execute, pool, queryOne } from '../src/db.js';
import { now, toSql } from '../src/time.js';
import { pathToFileURL } from 'node:url';
import { runMigrations } from './migrate.js';

/**
 * Tạo tài khoản admin đầu tiên. Chạy lại nhiều lần không tạo trùng và **không** ghi đè
 * mật khẩu của tài khoản đã có — tránh việc chạy nhầm làm mất mật khẩu đang dùng.
 */
export async function seedAdmin(): Promise<'created' | 'exists'> {
  const { username, displayName, password } = config.seedAdmin;
  if (!password) throw new Error('Thiếu SEED_ADMIN_PASSWORD — không thể seed tài khoản admin.');
  if (password.length < 8) throw new Error('SEED_ADMIN_PASSWORD phải có ít nhất 8 ký tự.');

  const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) return 'exists';

  const stamp = toSql(now());
  await execute(
    `INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 1, 1, ?, ?)`,
    [username, displayName, await hashPassword(password), stamp, stamp]
  );
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(seedAdmin)
    .then(async result => {
      console.log(
        result === 'created'
          ? `Đã tạo admin '${config.seedAdmin.username}'. Đăng nhập lần đầu sẽ bị buộc đổi mật khẩu.`
          : `Tài khoản '${config.seedAdmin.username}' đã tồn tại — không thay đổi gì.`
      );
      await pool.end();
    })
    .catch(async error => {
      console.error('Seed admin thất bại:', error);
      await pool.end();
      process.exit(1);
    });
}
