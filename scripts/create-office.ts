import { randomBytes } from 'node:crypto';
import { createLogger, createPools, hashPassword, loadEnv, withTx } from '@pos/core';
import { requiredArg, stringArg } from './_args';

/**
 * ساخت دفتر جدید و اولین مدیر دفتر.
 *   npm run create-office -- --code=tehran1 --name="دفتر تهران" --manager=admin1 [--password=...]
 * اگر --password نباشد، رمز تصادفی ساخته و یک‌بار چاپ می‌شود.
 */
const env = loadEnv();
const logger = createLogger(env, 'create-office');
const pools = createPools(env, logger, 'pos-create-office');

try {
  const code = requiredArg('code');
  const name = requiredArg('name');
  const username = requiredArg('manager').toLowerCase();
  const generated = stringArg('password') === undefined;
  const password = stringArg('password') ?? randomBytes(9).toString('base64url');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const hash = await hashPassword(password);

  const officeId = await withTx(pools.write, async (c) => {
    const o = await c.query<{ id: number }>('INSERT INTO offices (name, code) VALUES ($1, $2) RETURNING id', [name, code]);
    const id = o.rows[0]?.id as number;
    await c.query(
      `INSERT INTO users (office_id, username, password_hash, full_name, role) VALUES ($1, $2, $3, $4, 'office_manager')`,
      [id, username, hash, `مدیر ${name}`]);
    return id;
  });
  logger.info({ officeId, code, username }, 'office created');
  if (generated) console.log(`\nرمز موقت مدیر دفتر (فقط همین یک‌بار نمایش داده می‌شود): ${password}\n`);
} catch (err) {
  logger.error({ err }, 'create-office failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
