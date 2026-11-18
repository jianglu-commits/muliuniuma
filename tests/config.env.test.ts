import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFileIfPresent } from '../src/config/index.js';
import { ConfigError } from '../src/shared/index.js';

const BASE = {
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'gpt-4o-mini',
  LLM_BASE_URL: 'https://example.com/v1',
  LLM_API_KEY: 'sk-test',
};

/** 运行回调并返回它抛出的错误；没有抛错则让用例失败。 */
function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the callback to throw');
}

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
    const run = (): void => {
      loadConfig({ ...BASE, LLM_API_KEY: undefined });
    };

    expect(run).toThrowError(/LLM_API_KEY/);
    expect(run).toThrowError(ConfigError);

    const error = captureError(run);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe('CONFIG_INVALID');
    expect((error as Error).message).toMatch(/LLM_API_KEY/);
  });

  it('非法的 A2A_PORT 抛错并指出期望范围', () => {
    const run = (): void => {
      loadConfig({ ...BASE, A2A_PORT: 'not-a-port' });
    };

    expect(run).toThrowError(/A2A_PORT/);
    expect(run).toThrowError(ConfigError);

    const error = captureError(run);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe('CONFIG_INVALID');
    expect((error as Error).message).toMatch(/A2A_PORT/);
  });

  it('数值项非法时报出变量名', () => {
    const run = (): void => {
      loadConfig({ ...BASE, SANDBOX_TIMEOUT_MS: '0' });
    };

    expect(run).toThrowError(/SANDBOX_TIMEOUT_MS/);
    expect(run).toThrowError(ConfigError);

    const error = captureError(run);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe('CONFIG_INVALID');
    expect((error as Error).message).toMatch(/SANDBOX_TIMEOUT_MS/);
  });
});

describe('loadEnvFileIfPresent', () => {
  const originalEnv = new Map<string, string | undefined>();
  const tempDirs: string[] = [];

  const track = (key: string): void => {
    if (!originalEnv.has(key)) {
      originalEnv.set(key, process.env[key]);
    }
  };

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在（ENOENT）时静默忽略、不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    const missing = join(dir, 'absent.env');
    expect(existsSync(missing)).toBe(false);
    expect(() => loadEnvFileIfPresent(missing)).not.toThrow();
  });

  it('文件存在但读不了时抛出错误，不被静默吞掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    // 目录存在，但不是可读的 .env 文件：process.loadEnvFile 会以非 ENOENT 的错误码失败
    expect(existsSync(dir)).toBe(true);

    expect(() => loadEnvFileIfPresent(dir)).toThrow();

    const error = captureError(() => loadEnvFileIfPresent(dir));
    expect((error as NodeJS.ErrnoException).code).not.toBe('ENOENT');
  });

  it('读取文件中的变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    const file = join(dir, '.env');
    writeFileSync(file, 'CONFIG_ENV_FILE_ONLY_VAR=fromfile\n');
    track('CONFIG_ENV_FILE_ONLY_VAR');
    delete process.env['CONFIG_ENV_FILE_ONLY_VAR'];

    loadEnvFileIfPresent(file);

    expect(process.env['CONFIG_ENV_FILE_ONLY_VAR']).toBe('fromfile');
  });

  it('不覆盖已经存在的环境变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muliuniuma-env-'));
    tempDirs.push(dir);
    const file = join(dir, '.env');
    writeFileSync(file, 'CONFIG_ENV_FILE_EXISTING_VAR=fromfile\n');
    track('CONFIG_ENV_FILE_EXISTING_VAR');
    process.env['CONFIG_ENV_FILE_EXISTING_VAR'] = 'existing';

    loadEnvFileIfPresent(file);

    expect(process.env['CONFIG_ENV_FILE_EXISTING_VAR']).toBe('existing');
  });
});

describe('loadConfig 默认参数（读取真实 process.env）', () => {
  const originalEnv = new Map<string, string | undefined>();

  const REQUIRED_ENV = {
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_BASE_URL: 'https://example.com/v1',
    LLM_API_KEY: 'sk-test',
  };

  // 可选项先清掉，保证用例不受外部环境污染、只考察默认路径本身
  const OPTIONAL_ENV_KEYS = [
    'LLM_TEMPERATURE',
    'SANDBOX_ROOT',
    'SANDBOX_TIMEOUT_MS',
    'SANDBOX_MAX_OUTPUT_BYTES',
    'CHECKPOINT_DB',
    'SKILLS_DIR',
    'MCP_CONFIG',
    'A2A_PEERS',
    'A2A_PORT',
    'A2A_PUBLIC_URL',
    'A2A_AGENT_NAME',
    'A2A_DESCRIPTION',
    'LOG_LEVEL',
  ];

  const track = (key: string): void => {
    if (!originalEnv.has(key)) {
      originalEnv.set(key, process.env[key]);
    }
  };

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
  });

  it('不传参数时从 process.env 读取配置', () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      track(key);
      process.env[key] = value;
    }
    for (const key of OPTIONAL_ENV_KEYS) {
      track(key);
      delete process.env[key];
    }

    const config = loadConfig();

    expect(config.model.provider).toBe('openai-compatible');
    expect(config.model.model).toBe('gpt-4o-mini');
    expect(config.model.baseURL).toBe('https://example.com/v1');
    expect(config.model.apiKey).toBe('sk-test');
    expect(config.sandbox.timeoutMs).toBe(30_000);
    expect(config.a2a.port).toBe(4124);
    expect(config.logLevel).toBe('info');
  });
});
