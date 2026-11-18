import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/shared/index.js';

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
});
