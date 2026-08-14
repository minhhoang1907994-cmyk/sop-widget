// MySQL DATETIME không mang offset, nên quy ước là: mọi giá trị đọc/ghi đều là UTC.
// Hai hàm dưới là chỗ duy nhất chuyển đổi giữa Date của JS và chuỗi MySQL.

export function now(): Date {
  return new Date();
}

/** Date → 'YYYY-MM-DD HH:MM:SS.mmm' theo UTC, dạng MySQL nhận trực tiếp. */
export function toSql(date: Date): string {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

/** Chuỗi DATETIME của MySQL (đã là UTC) → chuỗi RFC3339 để trả ra API. */
export function toIso(value: string | null): string | null {
  if (!value) return null;
  return `${value.replace(' ', 'T')}Z`;
}

/** Chuỗi RFC3339 nhận từ client → chuỗi MySQL. Ném lỗi nếu không phải thời điểm hợp lệ. */
export function fromIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Giá trị thời gian không hợp lệ: ${value}`);
  return toSql(parsed);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
