import pino from 'pino';

export type AppLogger = pino.Logger;

/**
 * Single logging factory. Pretty output only when attached to a TTY so that CI,
 * `docker logs` and redirected eval output stay machine-readable JSON.
 */
export function createLogger(options: { level?: string; name?: string } = {}): AppLogger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true;
  return pino({
    name: options.name ?? 'clinical-voice',
    level,
    base: undefined,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export const noopLogger: AppLogger = pino({ level: 'silent' });
