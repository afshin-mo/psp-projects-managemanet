import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createPools, loadEnv, runMigrations } from '@pos/core';

const env = loadEnv();
const logger = createLogger(env, 'migrate');
const pools = createPools(env, logger, 'pos-migrate');
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

try {
  const r = await runMigrations(pools.write, dir, (m) => logger.info(m));
  logger.info({ applied: r.applied.length, skipped: r.skipped.length }, 'migrations done');
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
