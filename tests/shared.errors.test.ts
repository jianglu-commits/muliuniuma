import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigError,
  ProviderNotRegisteredError,
  SandboxEscapeError,
  SkillNotFoundError,
} from '../src/shared/index.js';

describe('AppError', () => {
  it('保留错误码并保留 cause', () => {
    const cause = new Error('root');
    const err = new AppError('CONFIG_INVALID', 'boom', { cause });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('子类各自带固定 code', () => {
    expect(new ConfigError('x').code).toBe('CONFIG_INVALID');
    expect(new SandboxEscapeError('x').code).toBe('SANDBOX_ESCAPE');
    expect(new SkillNotFoundError('x').code).toBe('SKILL_NOT_FOUND');
    expect(new ProviderNotRegisteredError('x').code).toBe('PROVIDER_NOT_REGISTERED');
  });

  it('provider 未注册时提示要装哪个包', () => {
    const err = new ProviderNotRegisteredError('anthropic');
    expect(err.message).toContain('anthropic');
    expect(err.message).toContain('registerProvider');
  });
});
