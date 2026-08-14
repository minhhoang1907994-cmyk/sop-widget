import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../config.js';
import { errors } from '../errors.js';
import { resolveSession } from './service.js';
import type { AuthContext } from '../types.js';

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return undefined;
  return value.trim();
}

/**
 * BR-16: mọi endpoint Bearer đều cần phiên hợp lệ.
 * Q15: khi `must_change_password = 1`, chặn ngay ở server thay vì chỉ ẩn màn hình ở app —
 * nếu chỉ chặn phía frontend thì gọi thẳng API là đi vòng được.
 */
export function requireAuth(options: { allowPasswordChangePending?: boolean } = {}) {
  return async function preHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const context = await resolveSession(bearerToken(request));
    if (!context) throw errors.unauthenticated();
    if (!options.allowPasswordChangePending && context.user.must_change_password === 1) {
      throw errors.passwordChangeRequired();
    }
    request.auth = context;
  };
}

export function requireAdmin() {
  return async function preHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const context = request.auth;
    if (!context) throw errors.unauthenticated();
    if (context.user.role !== 'admin') throw errors.forbidden();
  };
}

export function auth(request: FastifyRequest): AuthContext {
  const context = request.auth;
  if (!context) throw errors.unauthenticated();
  return context;
}

/** Kênh web dùng cookie. Trả null thay vì ném lỗi để route tự quyết định chuyển hướng. */
export async function resolveCookieSession(request: FastifyRequest): Promise<AuthContext | null> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  return resolveSession(raw);
}
