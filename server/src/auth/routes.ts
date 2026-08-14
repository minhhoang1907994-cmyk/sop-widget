import type { FastifyInstance } from 'fastify';
import { execute, queryOne } from '../db.js';
import { errors } from '../errors.js';
import { clearLoginFailures, isLoginBlocked, recordLoginFailure } from '../rate-limit.js';
import { now, toIso, toSql } from '../time.js';
import type { UserRow } from '../types.js';
import { auth, requireAuth } from './guard.js';
import {
  authenticate,
  createSession,
  hashPassword,
  revokeAllSessions,
  revokeSession,
  verifyPassword
} from './service.js';

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

interface PasswordBody {
  current_password?: unknown;
  new_password?: unknown;
}

export const MIN_PASSWORD_LENGTH = 8;

/** Q2 — giá trị tạm: tối thiểu 8 ký tự, chưa kiểm tra độ phức tạp. */
export function assertPasswordPolicy(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > 256) {
    throw errors.validation(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
  }
  return value;
}

function readCredentials(body: LoginBody): { username: string; password: string } {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    throw errors.validation('Vui lòng nhập tên đăng nhập và mật khẩu.');
  }
  return { username, password };
}

export function publicUser(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    must_change_password: user.must_change_password === 1
  };
}

/**
 * Dùng chung cho kênh app và kênh web: kiểm tra hạn mức trước, xác thực, rồi ghi nhận
 * thất bại vào cùng một bộ đếm.
 */
export async function loginWithRateLimit(
  ip: string,
  rawUsername: string,
  password: string
): Promise<UserRow> {
  const username = rawUsername.trim();
  if (isLoginBlocked(ip, username)) throw errors.tooManyRequests();
  try {
    const user = await authenticate(username, password);
    clearLoginFailures(ip, username);
    return user;
  } catch (error) {
    recordLoginFailure(ip, username);
    throw error;
  }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const { username, password } = readCredentials((request.body ?? {}) as LoginBody);
    const user = await loginWithRateLimit(request.ip, username, password);
    const session = await createSession(user.id, 'app');
    return reply.code(200).send({
      data: {
        token: session.token,
        expires_at: session.expiresAt.toISOString(),
        user: publicUser(user)
      }
    });
  });

  app.post(
    '/api/v1/auth/logout',
    { preHandler: [requireAuth({ allowPasswordChangePending: true })] },
    async (request, reply) => {
      await revokeSession(auth(request).sessionId);
      return reply.code(204).send();
    }
  );

  app.get(
    '/api/v1/auth/me',
    { preHandler: [requireAuth({ allowPasswordChangePending: true })] },
    async (request, reply) => {
      const context = auth(request);
      return reply.code(200).send({
        data: { ...publicUser(context.user), expires_at: toIso(context.expiresAt) }
      });
    }
  );

  app.post(
    '/api/v1/auth/password',
    { preHandler: [requireAuth({ allowPasswordChangePending: true })] },
    async (request, reply) => {
      const context = auth(request);
      const body = (request.body ?? {}) as PasswordBody;
      const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
      const newPassword = assertPasswordPolicy(body.new_password);

      const fresh = await queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [context.user.id]);
      if (!fresh) throw errors.userNotFound();

      const ok = await verifyPassword(fresh.password_hash, currentPassword);
      if (!ok) throw errors.invalidCredentials('Mật khẩu hiện tại không đúng.');

      if (await verifyPassword(fresh.password_hash, newPassword)) {
        throw errors.validation('Mật khẩu mới không hợp lệ hoặc trùng mật khẩu cũ.');
      }

      await execute(
        'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
        [await hashPassword(newPassword), toSql(now()), fresh.id]
      );
      // Giữ lại đúng phiên đang thao tác — người vừa đổi mật khẩu không tự đăng xuất mình.
      await revokeAllSessions(fresh.id, context.sessionId);
      return reply.code(204).send();
    }
  );
}
