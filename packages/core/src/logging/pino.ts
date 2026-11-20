import { pino, type Logger } from 'pino';
import type { Env } from '../config/env';

export type { Logger };

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, service: string): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.password_hash',
        '*.refreshToken',
        '*.token',
      ],
      censor: '[redacted]',
    },
  });
}
