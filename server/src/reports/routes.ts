import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auth, requireAuth } from '../auth/guard.js';
import { config } from '../config.js';
import { errors } from '../errors.js';
import { fromIso } from '../time.js';
import type { RunStatus } from '../types.js';
import { absolutePathFor } from './storage.js';
import {
  createReport,
  decodeCursor,
  listInbox,
  listSent,
  loadAccessibleReport,
  markViewed,
  reportDetail
} from './service.js';
import { createReadStream } from 'node:fs';

const RUN_STATUSES: RunStatus[] = ['running', 'completed', 'cancelled'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Fields {
  [key: string]: string | string[];
}

function single(fields: Fields, name: string): string {
  const value = fields[name];
  if (Array.isArray(value)) return value[value.length - 1] ?? '';
  return value ?? '';
}

function parseRecipientIds(fields: Fields): number[] {
  const raw = fields['recipient_ids'];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const ids: number[] = [];
  for (const entry of values) {
    // Chấp nhận cả nhiều field cùng tên lẫn một field chứa mảng JSON.
    if (entry.trim().startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry);
      } catch {
        throw errors.validation('Danh sách người nhận không hợp lệ.');
      }
      if (!Array.isArray(parsed)) throw errors.validation('Danh sách người nhận không hợp lệ.');
      for (const item of parsed) ids.push(toUserId(item));
    } else {
      ids.push(toUserId(entry));
    }
  }
  return ids;
}

function toUserId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw errors.validation('Danh sách người nhận không hợp lệ.');
  return id;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw errors.validation('Tham số limit phải là số nguyên từ 1 đến 200.');
  }
  return limit;
}

async function readMultipart(request: FastifyRequest): Promise<{ file: MultipartFile; fields: Fields }> {
  const fields: Fields = {};
  let file: MultipartFile | null = null;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') {
        await part.toBuffer();
        continue;
      }
      file = part;
      // Buffer phải được đọc ngay trong vòng lặp: sang part kế tiếp là stream đóng lại.
      const buffer = await part.toBuffer();
      Object.defineProperty(part, 'cachedBuffer', { value: buffer });
    } else {
      const existing = fields[part.fieldname];
      const value = String(part.value);
      if (existing === undefined) fields[part.fieldname] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else fields[part.fieldname] = [existing, value];
    }
  }

  if (!file) throw errors.validation('Thiếu tệp báo cáo.');
  return { file, fields };
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/reports', { preHandler: [requireAuth()] }, async (request, reply) => {
    const context = auth(request);
    if (!request.isMultipart()) throw errors.validation('Yêu cầu phải ở dạng multipart/form-data.');

    const { file, fields } = await readMultipart(request);
    const content = (file as MultipartFile & { cachedBuffer: Buffer }).cachedBuffer;

    if (file.file.truncated || content.byteLength > config.maxUploadBytes) {
      throw errors.fileTooLarge(config.maxUploadMb);
    }
    const mimetype = (file.mimetype ?? '').toLowerCase();
    if (!mimetype.startsWith('text/html')) throw errors.unsupportedType();

    const runId = single(fields, 'run_id');
    if (!UUID_PATTERN.test(runId)) throw errors.validation('Mã lần chạy không hợp lệ.');

    const procedureName = single(fields, 'procedure_name').trim();
    if (!procedureName || procedureName.length > 255) throw errors.validation('Tên quy trình không hợp lệ.');

    const operatorDisplayName = single(fields, 'operator_display_name').trim();
    if (!operatorDisplayName || operatorDisplayName.length > 128) {
      throw errors.validation('Tên người thực hiện không hợp lệ.');
    }

    const runStatus = single(fields, 'run_status') as RunStatus;
    if (!RUN_STATUSES.includes(runStatus)) throw errors.validation('Trạng thái lần chạy không hợp lệ.');

    let runStartedAt: string;
    try {
      runStartedAt = fromIso(single(fields, 'run_started_at'));
    } catch {
      throw errors.validation('Thời điểm bắt đầu lần chạy không hợp lệ.');
    }

    const created = await createReport({
      sender: context.user,
      runId,
      procedureName,
      operatorDisplayName,
      runStartedAt,
      runStatus,
      recipientIds: parseRecipientIds(fields),
      content
    });

    return reply.code(201).send({
      data: {
        id: created.id,
        share_url: `${config.publicBaseUrl}/r/${created.id}`,
        size_bytes: created.sizeBytes,
        sha256: created.sha256,
        recipients: created.recipients
      }
    });
  });

  app.get('/api/v1/reports/inbox', { preHandler: [requireAuth()] }, async (request, reply) => {
    const context = auth(request);
    const queryParams = request.query as { limit?: string; cursor?: string };
    const result = await listInbox(context.user.id, {
      limit: parseLimit(queryParams.limit),
      cursor: decodeCursor(queryParams.cursor)
    });
    return reply.send({ data: result.items, next_cursor: result.nextCursor });
  });

  app.get('/api/v1/reports/sent', { preHandler: [requireAuth()] }, async (request, reply) => {
    const context = auth(request);
    const queryParams = request.query as { limit?: string; cursor?: string };
    const result = await listSent(context.user.id, {
      limit: parseLimit(queryParams.limit),
      cursor: decodeCursor(queryParams.cursor)
    });
    return reply.send({ data: result.items, next_cursor: result.nextCursor });
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/reports/:id',
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const context = auth(request);
      const access = await loadAccessibleReport(request.params.id, context.user);
      return reply.send({ data: await reportDetail(access, context.user) });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/reports/:id/content',
    { preHandler: [requireAuth()] },
    async (request, reply) => {
      const context = auth(request);
      const access = await loadAccessibleReport(request.params.id, context.user);
      if (access.isRecipient) await markViewed(access.report.id, context.user);
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Security-Policy', REPORT_CSP)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="report-${access.report.run_id}.html"`)
        .send(createReadStream(absolutePathFor(access.report.storage_path)));
    }
  );
}

/**
 * Q6 (giá trị tạm): tệp báo cáo là nội dung do người dùng tạo và có thể bị sửa tay trước
 * khi tải lên. Chỉ cho phép ảnh dạng data: (BR-10 nhúng base64) và style nội tuyến;
 * chặn script, chặn mọi kết nối ra ngoài, chặn nhúng vào khung của trang khác.
 */
export const REPORT_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "sandbox allow-popups"
].join('; ');
