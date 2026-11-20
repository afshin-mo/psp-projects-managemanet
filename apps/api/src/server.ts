import {
  EnvError, PgBossQueue, createBoss, createLogger, createPools, createStorage, ensureAuditPartitions, ensureQueues, loadEnv,
} from '@pos/core';
import { todayInTehran } from '@pos/shared';
import { buildApp } from './app';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const logger = createLogger(env, 'api');
  const pools = createPools(env, logger, 'pos-api');
  // audit_log پارتیشن ماه جاری را لازم دارد. (از فاز ۲ job زمان‌بندی‌شده این کار را می‌کند.)
  try {
    await ensureAuditPartitions(pools.write, todayInTehran(), 0, 3);
  } catch (err) {
    logger.error({ err }, 'could not ensure audit partitions (run migrations and db:seed-periods first)');
  }
  const boss = createBoss(env, logger, 'api');
  await boss.start();
  await ensureQueues(boss);
  const app = await buildApp({ env, logger, pools, storage: createStorage(env), queue: new PgBossQueue(boss) });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await boss.stop();
      await pools.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
