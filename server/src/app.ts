import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/routes.js';
import { config } from './config.js';
import { ApiError, errors, sendError } from './errors.js';
import { registerReportRoutes } from './reports/routes.js';
import { registerUserRoutes } from './users/routes.js';
import { registerWebRoutes } from './web/routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: config.maxUploadBytes + 1024 * 1024,
    trustProxy: true
  });

  await app.register(cookie);
  // Form đăng nhập của trang web gửi dạng urlencoded, mà Fastify chỉ hiểu JSON sẵn.
  // Dùng URLSearchParams thay vì thêm plugin cho một endpoint duy nhất.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error);
      }
    }
  );
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 }
  });
  // Hạn mức chung cho mọi endpoint (§12). Hạn mức riêng cho đăng nhập nằm ở src/rate-limit.ts
  // vì nó phải đếm chung giữa kênh app và kênh web, và đếm theo cả tên đăng nhập.
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    // Trang đăng nhập và trang xem báo cáo do trình duyệt tải, không nên dính hạn mức API.
    allowList: (request): boolean => request.url === '/login' || request.url.startsWith('/r/'),
    errorResponseBuilder: () => {
      const error = errors.tooManyRequests();
      return { statusCode: error.status, error: error.code, message: error.message };
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return sendError(reply, error);
    }
    // Tệp vượt giới hạn được @fastify/multipart ném ra trước khi handler chạy.
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return sendError(reply, errors.fileTooLarge(config.maxUploadMb));
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return sendError(reply, errors.tooManyRequests());
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.' } });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return sendError(reply, errors.notFound());
    return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8">Không tìm thấy trang.');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerReportRoutes(app);
  await registerWebRoutes(app);

  return app;
}
