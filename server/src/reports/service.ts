import { randomUUID } from 'node:crypto';
import { execute, pool, query, queryOne, withTransaction, type SqlParam } from '../db.js';
import { errors } from '../errors.js';
import { now, toIso, toSql } from '../time.js';
import type { RecipientView, ReportRow, ReportSummary, RunStatus, UserRow } from '../types.js';
import { relativePathFor, removeReportFile, sha256, writeReportFile } from './storage.js';

export interface CreateReportInput {
  sender: UserRow;
  runId: string;
  procedureName: string;
  operatorDisplayName: string;
  runStartedAt: string;
  runStatus: RunStatus;
  recipientIds: number[];
  content: Buffer;
}

export interface CreatedReport {
  id: string;
  sizeBytes: number;
  sha256: string;
  recipients: { id: number; display_name: string }[];
}

/**
 * Thứ tự kiểm tra người nhận theo §5.2: bỏ trùng → bỏ chính người gửi (BR-29) →
 * rỗng thì báo lỗi → còn lại phải tồn tại và đang hoạt động.
 * Hai bước đầu im lặng, không coi là lỗi.
 */
export async function resolveRecipients(
  senderId: number,
  rawIds: number[]
): Promise<{ id: number; display_name: string }[]> {
  const unique = [...new Set(rawIds)].filter(id => id !== senderId);
  if (unique.length === 0) throw errors.noRecipient();

  const placeholders = unique.map(() => '?').join(',');
  const rows = await query<{ id: number; display_name: string }>(
    `SELECT id, display_name FROM users WHERE is_active = 1 AND id IN (${placeholders})`,
    unique
  );
  if (rows.length !== unique.length) throw errors.recipientNotFound();
  return rows;
}

export async function createReport(input: CreateReportInput): Promise<CreatedReport> {
  const recipients = await resolveRecipients(input.sender.id, input.recipientIds);

  const id = randomUUID();
  const createdAt = now();
  const relativePath = relativePathFor(id, createdAt);
  const digest = sha256(input.content);

  await writeReportFile(relativePath, input.content);
  try {
    await withTransaction(async conn => {
      await conn.execute(
        `INSERT INTO reports
           (id, run_id, sender_id, procedure_name, operator_display_name, run_started_at,
            run_status, storage_path, size_bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.runId,
          input.sender.id,
          input.procedureName,
          input.operatorDisplayName,
          input.runStartedAt,
          input.runStatus,
          relativePath,
          input.content.byteLength,
          digest,
          toSql(createdAt)
        ]
      );
      for (const recipient of recipients) {
        await conn.execute(
          'INSERT INTO report_recipients (report_id, user_id, created_at) VALUES (?, ?, ?)',
          [id, recipient.id, toSql(createdAt)]
        );
      }
    });
  } catch (error) {
    // Ghi DB hỏng thì không để lại tệp mồ côi trên đĩa.
    await removeReportFile(relativePath);
    throw error;
  }

  return { id, sizeBytes: input.content.byteLength, sha256: digest, recipients };
}

interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  // Tách ở dấu phân cách **đầu tiên**: phần thời gian có định dạng cố định và không chứa
  // ký tự này, còn phần id thì không nên giả định là không chứa.
  const separator = decoded.indexOf('|');
  if (separator <= 0) throw errors.validation('Con trỏ phân trang không hợp lệ.');
  return { createdAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

interface ListOptions {
  limit: number;
  cursor: Cursor | null;
}

type ListRow = ReportRow & { sender_display_name: string; first_viewed_at: string | null };

async function recipientsOf(reportIds: string[]): Promise<Map<string, RecipientView[]>> {
  const map = new Map<string, RecipientView[]>();
  if (reportIds.length === 0) return map;
  const placeholders = reportIds.map(() => '?').join(',');
  const rows = await query<{
    report_id: string;
    id: number;
    display_name: string;
    first_viewed_at: string | null;
  }>(
    `SELECT rr.report_id, u.id, u.display_name, rr.first_viewed_at
       FROM report_recipients rr
       JOIN users u ON u.id = rr.user_id
      WHERE rr.report_id IN (${placeholders})
      ORDER BY u.display_name`,
    reportIds
  );
  for (const row of rows) {
    const list = map.get(row.report_id) ?? [];
    list.push({ id: row.id, display_name: row.display_name, first_viewed_at: toIso(row.first_viewed_at) });
    map.set(row.report_id, list);
  }
  return map;
}

function baseSummary(row: ListRow): ReportSummary {
  return {
    id: row.id,
    run_id: row.run_id,
    procedure_name: row.procedure_name,
    operator_display_name: row.operator_display_name,
    run_started_at: toIso(row.run_started_at),
    run_status: row.run_status,
    size_bytes: Number(row.size_bytes),
    created_at: toIso(row.created_at),
    sender: { id: row.sender_id, display_name: row.sender_display_name }
  };
}

export interface ReportPage {
  items: ReportSummary[];
  nextCursor: string | null;
}

/**
 * Phân trang theo `(created_at, id)` giảm dần. Phải có `id` làm khóa phụ: hai báo cáo
 * trùng millisecond mà chỉ so `created_at` sẽ làm trang sau bỏ sót hoặc lặp bản ghi.
 */
export async function listInbox(userId: number, options: ListOptions): Promise<ReportPage> {
  const params: SqlParam[] = [userId];
  let condition = '';
  if (options.cursor) {
    condition = ' AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))';
    params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
  }
  const rows = await query<ListRow>(
    `SELECT r.*, u.display_name AS sender_display_name, rr.first_viewed_at
       FROM report_recipients rr
       JOIN reports r ON r.id = rr.report_id
       JOIN users u ON u.id = r.sender_id
      WHERE rr.user_id = ?${condition}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${options.limit + 1}`,
    params
  );
  return page(rows, options.limit, row => ({ ...baseSummary(row), first_viewed_at: toIso(row.first_viewed_at) }));
}

export async function listSent(userId: number, options: ListOptions): Promise<ReportPage> {
  const params: SqlParam[] = [userId];
  let condition = '';
  if (options.cursor) {
    condition = ' AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))';
    params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
  }
  const rows = await query<ListRow>(
    `SELECT r.*, u.display_name AS sender_display_name, NULL AS first_viewed_at
       FROM reports r
       JOIN users u ON u.id = r.sender_id
      WHERE r.sender_id = ?${condition}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${options.limit + 1}`,
    params
  );
  const result = page(rows, options.limit, baseSummary);
  const recipients = await recipientsOf(result.items.map(item => item.id));
  for (const item of result.items) item.recipients = recipients.get(item.id) ?? [];
  return result;
}

function page(rows: ListRow[], limit: number, map: (row: ListRow) => ReportSummary): ReportPage {
  const visible = rows.slice(0, limit);
  const items = visible.map(map);
  const last = visible[visible.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
  return { items, nextCursor };
}

export interface ReportAccess {
  report: ReportRow;
  senderDisplayName: string;
  isSender: boolean;
  isRecipient: boolean;
  isAdmin: boolean;
}

/**
 * BR-18 + BR-31: người không phải người gửi / người nhận / admin nhận `404`, không phải
 * `403` — nếu trả `403` thì id báo cáo trở thành thứ dò được.
 */
export async function loadAccessibleReport(reportId: string, viewer: UserRow): Promise<ReportAccess> {
  const row = await queryOne<ReportRow & { sender_display_name: string }>(
    `SELECT r.*, u.display_name AS sender_display_name
       FROM reports r JOIN users u ON u.id = r.sender_id
      WHERE r.id = ?`,
    [reportId]
  );
  if (!row) throw errors.reportNotFound();

  const recipient = await queryOne<{ id: number }>(
    'SELECT id FROM report_recipients WHERE report_id = ? AND user_id = ?',
    [reportId, viewer.id]
  );
  const isSender = row.sender_id === viewer.id;
  const isAdmin = viewer.role === 'admin';
  if (!isSender && !recipient && !isAdmin) throw errors.reportNotFound();

  return {
    report: row,
    senderDisplayName: row.sender_display_name,
    isSender,
    isRecipient: recipient !== null,
    isAdmin
  };
}

/** Chỉ người nhận mới có mốc đã xem — người gửi và admin không có dòng trong bảng này. */
export async function markViewed(reportId: string, viewer: UserRow): Promise<void> {
  await execute(
    'UPDATE report_recipients SET first_viewed_at = ? WHERE report_id = ? AND user_id = ? AND first_viewed_at IS NULL',
    [toSql(now()), reportId, viewer.id]
  );
}

export async function reportDetail(access: ReportAccess, viewer: UserRow): Promise<ReportSummary> {
  const summary = baseSummary({
    ...access.report,
    sender_display_name: access.senderDisplayName,
    first_viewed_at: null
  });
  // Q18 (giá trị tạm): chỉ người gửi và admin thấy được ai đã nhận và ai đã xem.
  // Người nhận chỉ thấy mốc xem của chính mình.
  if (access.isSender || access.isAdmin) {
    summary.recipients = (await recipientsOf([access.report.id])).get(access.report.id) ?? [];
  } else {
    const own = await queryOne<{ first_viewed_at: string | null }>(
      'SELECT first_viewed_at FROM report_recipients WHERE report_id = ? AND user_id = ?',
      [access.report.id, viewer.id]
    );
    summary.first_viewed_at = toIso(own?.first_viewed_at ?? null);
  }
  return summary;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
