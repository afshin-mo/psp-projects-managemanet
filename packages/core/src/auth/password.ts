import { hash, verify } from '@node-rs/argon2';

// argon2id با حداقل توصیه‌ی OWASP (19 MiB, t=2, p=1)
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

let dummyHash: Promise<string> | undefined;

/**
 * اگر کاربر پیدا نشده باشد (stored=null) هم یک verify واقعی انجام می‌شود تا زمان پاسخ
 * وجود/نبود نام کاربری را لو ندهد.
 */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (stored === null) {
    dummyHash ??= hashPassword('timing-equalizer-password');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
