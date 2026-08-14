import { mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from '../db/migrate.js';

async function main(): Promise<void> {
  await mkdir(config.storageDir, { recursive: true });
  await runMigrations();

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`nhận ${signal}, đang tắt`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(error => {
  console.error('Không khởi động được máy chủ:', error);
  process.exit(1);
});
