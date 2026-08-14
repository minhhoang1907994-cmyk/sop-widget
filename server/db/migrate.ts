import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute, pool, query } from '../src/db.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Migration chạy một lần và ghi lại vào bảng `schema_migrations`, nên gọi lại nhiều lần
 * là an toàn — `index.ts` gọi nó mỗi lần khởi động.
 */
export async function runMigrations(): Promise<string[]> {
  await execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       VARCHAR(255) NOT NULL,
       applied_at DATETIME(3)  NOT NULL,
       PRIMARY KEY (name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migrations')).map(row => row.name)
  );
  const files = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  const executed: string[] = [];

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    // Bỏ dòng comment TRƯỚC khi tách. Nếu lọc sau khi tách, câu lệnh đầu tiên (vốn dính
    // khối comment ở đầu file) sẽ bị coi là comment và bị bỏ qua âm thầm.
    const statements = sql
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(/;\s*$/m)
      .map(statement => statement.trim())
      .filter(statement => statement.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }
    await execute('INSERT INTO schema_migrations (name, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [name]);
    executed.push(name);
  }
  return executed;
}

// Cho phép chạy trực tiếp: npm run migrate
// pathToFileURL cần thiết trên Windows — nối chuỗi 'file://' + đường dẫn cho ra hai dấu
// gạch chéo thay vì ba, nên so sánh không bao giờ khớp và khối này im lặng không chạy.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(async executed => {
      console.log(executed.length ? `Đã chạy: ${executed.join(', ')}` : 'Không có migration mới.');
      await pool.end();
    })
    .catch(async error => {
      console.error('Migration thất bại:', error);
      await pool.end();
      process.exit(1);
    });
}
