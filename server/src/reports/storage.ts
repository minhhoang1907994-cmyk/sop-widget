import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { errors } from '../errors.js';

/**
 * Đường dẫn lưu trong DB là **tương đối** so với `STORAGE_DIR`, để đổi thư mục gốc hoặc
 * chuyển máy chủ không làm hỏng liên kết của toàn bộ báo cáo cũ.
 */
export function relativePathFor(reportId: string, createdAt: Date): string {
  const year = createdAt.getUTCFullYear();
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return `${year}/${month}/${reportId}.html`;
}

export function absolutePathFor(relativePath: string): string {
  const absolute = resolve(config.storageDir, relativePath);
  const root = resolve(config.storageDir);
  // Chặn path traversal nếu giá trị trong DB bị can thiệp.
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw errors.reportNotFound();
  }
  return absolute;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function writeReportFile(relativePath: string, content: Buffer): Promise<void> {
  const absolute = absolutePathFor(relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EDQUOT') throw errors.storageFull();
    throw error;
  }
}

export async function removeReportFile(relativePath: string): Promise<void> {
  try {
    await unlink(absolutePathFor(relativePath));
  } catch {
    // Xóa dọn sau khi ghi DB thất bại — không có gì để xử lý thêm nếu tệp đã không còn.
  }
}

export function storageRoot(): string {
  return join(config.storageDir);
}
