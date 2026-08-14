import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { resolveCookieSession } from '../auth/guard.js';
import { createSession, revokeSession } from '../auth/service.js';
import { loginWithRateLimit } from '../auth/routes.js';
import { SESSION_COOKIE, config } from '../config.js';
import { ApiError } from '../errors.js';
import { REPORT_CSP } from '../reports/routes.js';
import { loadAccessibleReport, markViewed } from '../reports/service.js';
import { absolutePathFor } from '../reports/storage.js';
import { loginPage, messagePage } from './views.js';

/**
 * Chỉ nhận đường dẫn tương đối trỏ vào trang xem báo cáo. Mọi giá trị khác — URL tuyệt đối,
 * `//host` (protocol-relative), đường dẫn lạ — bị bỏ và thay bằng `/`, để tham số `next`
 * không dùng được làm bàn đạp chuyển hướng ra ngoài.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/r/') || raw.startsWith('//')) return '/';
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) return '/';
  return raw;
}

export async function registerWebRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', async (request, reply) => {
    const next = safeNext((request.query as { next?: string }).next);
    const session = await resolveCookieSession(request);
    if (session) return reply.redirect(next, 302);
    return reply.type('text/html; charset=utf-8').send(loginPage({ next }));
  });

  app.post('/login', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string; next?: string };
    const next = safeNext(body.next);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(loginPage({ next, error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' }));
    }

    try {
      const user = await loginWithRateLimit(request.ip, username, password);
      const session = await createSession(user.id, 'web');
      return reply
        .setCookie(SESSION_COOKIE, session.token, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: config.sessionTtlDays * 24 * 60 * 60,
          // Chỉ bật khi chạy sau HTTPS — trên http:// cờ này khiến trình duyệt bỏ cookie.
          secure: config.publicBaseUrl.startsWith('https://')
        })
        .redirect(next, 302);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Không đăng nhập được. Vui lòng thử lại.';
      const status = error instanceof ApiError ? error.status : 500;
      return reply
        .code(status)
        .type('text/html; charset=utf-8')
        .send(loginPage({ next, error: message }));
    }
  });

  app.post('/logout', async (request, reply) => {
    const session = await resolveCookieSession(request);
    if (session) await revokeSession(session.sessionId);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).redirect('/login', 302);
  });

  app.get<{ Params: { id: string } }>('/r/:id', async (request, reply) => {
    const session = await resolveCookieSession(request);
    if (!session) {
      return reply.redirect(`/login?next=${encodeURIComponent(`/r/${request.params.id}`)}`, 302);
    }
    if (session.user.must_change_password === 1) {
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send(
          messagePage('Cần đổi mật khẩu', 'Hãy mở SOP Widget và đổi mật khẩu trước khi xem báo cáo.')
        );
    }

    try {
      const access = await loadAccessibleReport(request.params.id, session.user);
      // Chỉ người nhận mới có mốc đã xem; người gửi và admin không có dòng trong bảng đó.
      if (access.isRecipient) await markViewed(access.report.id, session.user);
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Security-Policy', REPORT_CSP)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .send(createReadStream(absolutePathFor(access.report.storage_path)));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Không tìm thấy báo cáo.';
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(messagePage('Không tìm thấy báo cáo', message));
    }
  });
}
