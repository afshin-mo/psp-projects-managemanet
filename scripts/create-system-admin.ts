import { randomBytes } from 'node:crypto';
import { createLogger, createPools, hashPassword, loadEnv } from '@pos/core';
import { requiredArg, stringArg } from './_args';

/** ساخت کاربر ستاد مرکزی (بدون دفتر): npm run create-system-admin -- --username=central [--password=...] */
const env = loadEnv();
const logger = createLogger(env, 'create-system-admin');
const pools = createPools(env, logger, 'pos-create-sysadmin');

try {
  const username = requiredArg('username').toLowerCase();
  const generated = stringArg('password') === undefined;
  const password = stringArg('password') ?? randomBytes(9).toString('base64url');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  await pools.write.query(
    `INSERT INTO users (office_id, username, password_hash, full_name, role) VALUES (NULL, $1, $2, $3, 'system_admin')`,
    [username, await hashPassword(password), 'ستاد مرکزی']);
  logger.info({ username }, 'system admin created');
  if (generated) console.log(`\nرمز موقت: ${password}\n`);
} catch (err) {
  logger.error({ err }, 'create-system-admin failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
