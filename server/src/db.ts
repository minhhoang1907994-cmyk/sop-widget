import mysql from 'mysql2/promise';
import { config } from './config.js';

// Một pool dùng chung cho cả tiến trình. Mọi truy vấn đi qua prepared statement với
// placeholder `?` — không bao giờ nối chuỗi vào SQL (quy tắc project #2).
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
  // Trả DATETIME dưới dạng chuỗi để tự kiểm soát việc diễn giải sang UTC, thay vì để
  // driver dựng Date theo timezone của tiến trình.
  dateStrings: true,
  charset: 'utf8mb4_unicode_ci'
});

/** Kiểu giá trị được phép truyền vào placeholder `?`. */
export type SqlParam = string | number | boolean | Date | Buffer | null;

export async function query<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  const [rows] = await pool.execute(sql, params);
  return rows as T[];
}

export async function queryOne<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: SqlParam[] = []): Promise<mysql.ResultSetHeader> {
  const [result] = await pool.execute(sql, params);
  return result as mysql.ResultSetHeader;
}

export async function withTransaction<T>(handler: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
