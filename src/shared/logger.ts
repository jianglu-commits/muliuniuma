export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel, scope = 'app'): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    message: string,
    rest: unknown[],
  ): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const line = `[${lvl}] ${scope}: ${message}\n`;
    process.stderr.write(
      rest.length > 0 ? `${line}${rest.map((r) => String(r)).join(' ')}\n` : line,
    );
  };

  return {
    debug: (m, ...r) => emit('debug', m, r),
    info: (m, ...r) => emit('info', m, r),
    warn: (m, ...r) => emit('warn', m, r),
    error: (m, ...r) => emit('error', m, r),
    child: (childScope: string) => createLogger(level, `${scope}:${childScope}`),
  };
}
