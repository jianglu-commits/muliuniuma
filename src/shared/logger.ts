import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * 未识别的 level 必须 fail closed：回退到 info 阈值，
 * 避免未知配置把 debug（含 LLM 载荷）全量打进 stderr。
 * 查表只认自有属性，否则 'constructor'/'toString' 等 Object.prototype
 * 继承键会取到函数而非 undefined，导致阈值变 NaN 而重新 fail-open。
 */
const FALLBACK_LEVEL: LogLevel = 'info';

function resolveThreshold(level: string): number {
  if (Object.hasOwn(LEVEL_ORDER, level)) {
    return LEVEL_ORDER[level as LogLevel];
  }
  return LEVEL_ORDER[FALLBACK_LEVEL];
}

/**
 * 渲染 rest 参数：字符串原样输出，其余值用 node:util 的 inspect 保真格式化，
 * 保留对象结构与 Error 堆栈，避免 String(x) 退化成 "[object Object]"。
 */
function renderArg(value: unknown): string {
  if (typeof value === 'string') return value;
  return inspect(value, { depth: null, breakLength: Infinity, colors: false });
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel, scope = 'app'): Logger {
  const threshold = resolveThreshold(level);

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    message: string,
    rest: unknown[],
  ): void => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const suffix = rest.length > 0 ? ` ${rest.map(renderArg).join(' ')}` : '';
    process.stderr.write(`[${lvl}] ${scope}: ${message}${suffix}\n`);
  };

  return {
    debug: (m, ...r) => emit('debug', m, r),
    info: (m, ...r) => emit('info', m, r),
    warn: (m, ...r) => emit('warn', m, r),
    error: (m, ...r) => emit('error', m, r),
    child: (childScope: string) => createLogger(level, `${scope}:${childScope}`),
  };
}
