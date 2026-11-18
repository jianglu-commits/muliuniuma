import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type LogLevel } from '../../src/shared/index.js';

afterEach(() => vi.restoreAllMocks());

describe('createLogger', () => {
  it('低于当前等级的日志不输出', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('warn', 'test');
    log.debug('d');
    log.info('i');
    expect(spy).not.toHaveBeenCalled();
  });

  it('达到当前等级的日志输出到 stderr 并带 scope', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('info', 'scope');
    log.info('hello');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('scope');
    expect(String(spy.mock.calls[0]?.[0])).toContain('hello');
  });

  it('child 追加 scope 前缀', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createLogger('info', 'a').child('b').info('m');
    expect(String(spy.mock.calls[0]?.[0])).toContain('a:b');
  });

  it('rest 中的 Error 保留完整堆栈', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const err = new Error('boom');
    createLogger('info', 'scope').error('tool failed', err);
    const out = String(spy.mock.calls[0]?.[0]);
    expect(out).toContain('tool failed');
    expect(out).toContain('Error: boom');
    const stackFrame = err.stack?.split('\n')[1] ?? '';
    expect(stackFrame).not.toBe('');
    expect(out).toContain(stackFrame);
  });

  it('rest 中的普通对象保留键名而不是 [object Object]', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createLogger('info', 'scope').error('tool failed', {
      tool: 'search',
      attempt: 2,
    });
    const out = String(spy.mock.calls[0]?.[0]);
    expect(out).toContain('tool');
    expect(out).toContain('search');
    expect(out).toContain('attempt');
    expect(out).not.toContain('[object Object]');
  });

  it('rest 参数与消息在同一行', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    createLogger('info', 'scope').error('tool failed', { attempt: 1 });
    const out = String(spy.mock.calls[0]?.[0]);
    const messageIdx = out.indexOf('tool failed');
    expect(messageIdx).toBeGreaterThanOrEqual(0);
    const afterMessage = out.slice(messageIdx + 'tool failed'.length);
    // 消息与参数之间只有一个空格，且参数不另起一行
    expect(afterMessage.startsWith(' ')).toBe(true);
    expect(afterMessage.startsWith('  ')).toBe(false);
    const firstLine = afterMessage.split('\n')[0] ?? '';
    expect(firstLine).toContain('attempt');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('未知 level 时 fail closed：debug 被抑制，info/warn/error 仍输出', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('verbose' as unknown as LogLevel, 'scope');
    log.debug('suppressed');
    expect(spy).not.toHaveBeenCalled();
    log.info('kept-info');
    log.warn('kept-warn');
    log.error('kept-error');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(String(spy.mock.calls[0]?.[0])).toContain('kept-info');
    expect(String(spy.mock.calls[1]?.[0])).toContain('kept-warn');
    expect(String(spy.mock.calls[2]?.[0])).toContain('kept-error');
  });
});
