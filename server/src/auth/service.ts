import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { execute, query, queryOne, type SqlParam } from '../db.js';
import { errors } from '../errors.js';
import { addDays, now, toSql } from '../time.js';
import type { AuthContext, SessionClient, UserRow } from '../types.js';

// BR-24: mật khẩu dùng Argon2id. sha2/SHA-256 chỉ dùng cho toàn vẹn tệp, không dùng ở đây.
const ARGON_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// Hash của một mật khẩu giả, dùng để tiêu tốn đúng lượng thời gian như trường hợp
// tài khoản có thật khi username không tồn tại (Security Test #4 — không phân biệt được
// "sai tên" với "sai mật khẩu" qua thời gian phản hồi).
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argonHash('sop-widget-dummy-password', ARGON_OPTIONS);
  return dummyHashPromise;
}

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hashValue, plain, ARGON_OPTIONS);
  } catch {
    return false;
  }
}

/** BR-27: chỉ hash của token được lưu; token thô không bao giờ nằm trong DB. */
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export async function authenticate(username: string, password: string): Promise<UserRow> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    // Vẫn chạy một lần verify để thời gian phản hồi không tiết lộ tài khoản có tồn tại hay không.
    await verifyPassword(await dummyHash(), password);
    throw errors.invalidCredentials();
  }
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) throw errors.invalidCredentials();
  if (user.is_active !== 1) throw errors.accountDisabled();
  return user;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  sessionId: number;
}

export async function createSession(userId: number, client: SessionClient): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const createdAt = now();
  const expiresAt = addDays(createdAt, config.sessionTtlDays);
  const result = await execute(
    'INSERT INTO sessions (user_id, token_hash, client, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, hashToken(token), client, toSql(expiresAt), toSql(createdAt)]
  );
  return { token, expiresAt, sessionId: result.insertId };
}

/** Trả về ngữ cảnh phiên nếu token còn hiệu lực; null nếu thiếu, sai, đã thu hồi hoặc hết hạn. */
export async function resolveSession(rawToken: string | undefined): Promise<AuthContext | null> {
  if (!rawToken) return null;
  const row = await queryOne<UserRow & { session_id: number; client: SessionClient; expires_at: string }>(
    `SELECT u.*, s.id AS session_id, s.client, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3)`,
    [hashToken(rawToken)]
  );
  if (!row) return null;
  if (row.is_active !== 1) return null;
  await execute('UPDATE sessions SET last_used_at = ? WHERE id = ?', [toSql(now()), row.session_id]);
  return {
    user: row,
    sessionId: row.session_id,
    client: row.client,
    expiresAt: row.expires_at
  };
}

export async function revokeSession(sessionId: number): Promise<void> {
  await execute('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    toSql(now()),
    sessionId
  ]);
}

/**
 * Thu hồi mọi phiên của một tài khoản, cả kênh app lẫn kênh web (BR-26).
 * `exceptSessionId` để người vừa tự đổi mật khẩu không tự đăng xuất chính mình.
 */
export async function revokeAllSessions(userId: number, exceptSessionId?: number): Promise<number> {
  const params: SqlParam[] = [toSql(now()), userId];
  let sql = 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL';
  if (exceptSessionId !== undefined) {
    sql += ' AND id <> ?';
    params.push(exceptSessionId);
  }
  const result = await execute(sql, params);
  return result.affectedRows;
}

/** So sánh hai chuỗi bí mật không phụ thuộc độ dài khớp — dùng cho các so sánh token thủ công. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function countActiveAdmins(excludeUserId?: number): Promise<number> {
  const rows = await query<{ total: number }>(
    excludeUserId === undefined
      ? "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1"
      : "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?",
    excludeUserId === undefined ? [] : [excludeUserId]
  );
  return Number(rows[0]?.total ?? 0);
}
