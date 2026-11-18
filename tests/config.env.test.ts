import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFileIfPresent } from '../src/config/index.js';

const BASE = {
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'gpt-4o-mini',
  LLM_BASE_URL: 'https://example.com/v1',
  LLM_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('读取必填项并给出默认值', () => {
    const config = loadConfig({ ...BASE });
    expect(config.model.provider).toBe('openai-compatible');
    expect(config.model.model).toBe('gpt-4o-mini');
    expect(config.model.baseURL).toBe('https://example.com/v1');
    expect(config.sandbox.timeoutMs).toBe(30_000);
    expect(config.a2a.port).toBe(4124);
    expect(config.logLevel).toBe('info');
  });

  it('缺少 LLM_API_KEY 时抛出 ConfigError 并指出变量名', () => {
    expect(() => loadConfig({ ...BASE, LLM_API_KEY: undefined })).toThrowError(
      /LLM_API_KEY/,
    );
  });

  it('非法的 A2A_PORT 抛错并指出期望范围', () => {
    expect(() => loadConfig({ ...BASE, A2A_PORT: 'not-a-port' })).toThrowError(
      /A2A_PORT/,
    );
  });

  it('数值项非法时报出变量名', () => {
    expect(() => loadConfig({ ...BASE, SANDBOX_TIMEOUT_MS: '0' })).toThrowError(
      /SANDBOX_TIMEOUT_MS/,
    );
  });
});

describe('loadEnvFileIfPresent', () => {
  const touched: string[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const key of touched.splice(0)) {
      delete process.env[key];
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在时不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    expect(() => loadEnvFileIfPresent(join(dir, 'absent.env'))).not.toThrow();
  });

  it('读取文件中的变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    const file = join(dir, '.env');
    writeFileSync(file, 'CONFIG_ENV_FILE_ONLY_VAR=fromfile\n');
    touched.push('CONFIG_ENV_FILE_ONLY_VAR');

    loadEnvFileIfPresent(file);

    expect(process.env['CONFIG_ENV_FILE_ONLY_VAR']).toBe('fromfile');
  });

  it('不覆盖已经存在的环境变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    const file = join(dir, '.env');
    writeFileSync(file, 'CONFIG_ENV_FILE_EXISTING_VAR=fromfile\n');
    touched.push('CONFIG_ENV_FILE_EXISTING_VAR');
    process.env['CONFIG_ENV_FILE_EXISTING_VAR'] = 'existing';

    loadEnvFileIfPresent(file);

    expect(process.env['CONFIG_ENV_FILE_EXISTING_VAR']).toBe('existing');
  });
});
