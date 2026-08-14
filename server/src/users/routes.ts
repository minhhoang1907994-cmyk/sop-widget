import type { FastifyInstance } from 'fastify';
import { assertPasswordPolicy } from '../auth/routes.js';
import { auth, requireAdmin, requireAuth } from '../auth/guard.js';
import { countActiveAdmins, hashPassword, revokeAllSessions } from '../auth/service.js';
import { execute, query, queryOne } from '../db.js';
import { errors } from '../errors.js';
import { now, toIso, toSql } from '../time.js';
import type { AdminUserView, MemberUserView, Role, UserRow } from '../types.js';

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

interface CreateBody {
  username?: unknown;
  display_name?: unknown;
  password?: unknown;
  role?: unknown;
}

interface PatchBody {
  display_name?: unknown;
  role?: unknown;
  is_active?: unknown;
}

function assertUsername(value: unknown): string {
  if (typeof value !== 'string') throw errors.validation('Tên đăng nhập không hợp lệ.');
  const username = value.trim();
  if (username.length < 3 || username.length > 64 || !USERNAME_PATTERN.test(username)) {
    throw errors.validation('Tên đăng nhập chỉ gồm chữ thường, số và các ký tự . _ - (3–64 ký tự).');
  }
  return username;
}

function assertDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw errors.validation('Tên hiển thị không hợp lệ.');
  const displayName = value.trim();
  if (!displayName || displayName.length > 128) {
    throw errors.validation('Tên hiển thị phải có từ 1 đến 128 ký tự.');
  }
  return displayName;
}

function assertRole(value: unknown): Role {
  if (value !== 'admin' && value !== 'member') throw errors.validation('Quyền không hợp lệ.');
  return value;
}

function adminView(user: UserRow): AdminUserView {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    is_active: user.is_active === 1,
    must_change_password: user.must_change_password === 1,
    created_at: toIso(user.created_at)
  };
}

function memberView(user: UserRow): MemberUserView {
  return { id: user.id, display_name: user.display_name };
}

async function loadUser(id: number): Promise<UserRow> {
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw errors.userNotFound();
  return user;
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw errors.userNotFound();
  return id;
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // Danh sách dùng cho cả bộ chọn người nhận (member) lẫn màn hình quản lý (admin).
  // Không phân trang: số lượng bị chặn bởi quy mô team (§15).
  app.get('/api/v1/users', { preHandler: [requireAuth()] }, async (request, reply) => {
    const context = auth(request);
    const isAdmin = context.user.role === 'admin';
    const includeInactive =
      isAdmin && (request.query as { include_inactive?: string }).include_inactive === 'true';

    const rows = await query<UserRow>(
      includeInactive
        ? 'SELECT * FROM users ORDER BY display_name'
        : 'SELECT * FROM users WHERE is_active = 1 ORDER BY display_name'
    );

    if (isAdmin) {
      return reply.send({ data: rows.map(adminView) });
    }
    // Member không cần thấy chính mình: BR-29 loại người gửi khỏi danh sách người nhận.
    return reply.send({ data: rows.filter(row => row.id !== context.user.id).map(memberView) });
  });

  app.post('/api/v1/users', { preHandler: [requireAuth(), requireAdmin()] }, async (request, reply) => {
    const body = (request.body ?? {}) as CreateBody;
    const username = assertUsername(body.username);
    const displayName = assertDisplayName(body.display_name);
    const password = assertPasswordPolicy(body.password);
    const role = body.role === undefined ? 'member' : assertRole(body.role);

    const existing = await queryOne<{ id: number }>('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) throw errors.usernameTaken();

    const stamp = toSql(now());
    const result = await execute(
      `INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      [username, displayName, await hashPassword(password), role, stamp, stamp]
    );
    return reply.code(201).send({ data: adminView(await loadUser(result.insertId)) });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/v1/users/:id',
    { preHandler: [requireAuth(), requireAdmin()] },
    async (request, reply) => {
      const target = await loadUser(parseId(request.params.id));
      const body = (request.body ?? {}) as PatchBody;

      const displayName = body.display_name === undefined ? null : assertDisplayName(body.display_name);
      const role = body.role === undefined ? null : assertRole(body.role);
      const isActive = body.is_active === undefined ? null : body.is_active === true;
      if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
        throw errors.validation('Dữ liệu cập nhật không hợp lệ.');
      }
      if (displayName === null && role === null && isActive === null) {
        throw errors.validation('Dữ liệu cập nhật không hợp lệ.');
      }

      // Chặn tự khóa toàn hệ thống: hạ quyền hoặc vô hiệu hóa admin hoạt động cuối cùng.
      const losesAdmin = (role !== null && role !== 'admin') || isActive === false;
      if (target.role === 'admin' && target.is_active === 1 && losesAdmin) {
        if ((await countActiveAdmins(target.id)) === 0) throw errors.lastAdmin();
      }

      await execute(
        `UPDATE users
            SET display_name = COALESCE(?, display_name),
                role = COALESCE(?, role),
                is_active = COALESCE(?, is_active),
                updated_at = ?
          WHERE id = ?`,
        [displayName, role, isActive === null ? null : isActive ? 1 : 0, toSql(now()), target.id]
      );

      if (isActive === false) await revokeAllSessions(target.id);
      return reply.send({ data: adminView(await loadUser(target.id)) });
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/users/:id/password-reset',
    { preHandler: [requireAuth(), requireAdmin()] },
    async (request, reply) => {
      const target = await loadUser(parseId(request.params.id));
      const newPassword = assertPasswordPolicy((request.body as { new_password?: unknown })?.new_password);

      await execute(
        'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
        [await hashPassword(newPassword), toSql(now()), target.id]
      );
      // BR-26: đặt lại mật khẩu thu hồi mọi phiên, cả kênh app lẫn kênh web.
      const revoked = await revokeAllSessions(target.id);
      return reply.send({ data: { id: target.id, revoked_sessions: revoked } });
    }
  );
}
