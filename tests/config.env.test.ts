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
    expect(config.summary.enabled).toBe(true);
    expect(config.summary.triggerTokens).toBe(8000);
    expect(config.summary.keepTokens).toBe(2000);
    expect(config.summary.trimTokens).toBe(8000);
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

  it('SUMMARY_TRIGGER_TOKENS 非正数时报出变量名', () => {
    const run = (): void => {
      loadConfig({ ...BASE, SUMMARY_TRIGGER_TOKENS: '0' });
    };

    expect(run).toThrowError(/SUMMARY_TRIGGER_TOKENS/);
    expect(run).toThrowError(ConfigError);
  });

  it('SUMMARY_KEEP_TOKENS 非正数时报出变量名', () => {
    const run = (): void => {
      loadConfig({ ...BASE, SUMMARY_KEEP_TOKENS: '0' });
    };

    expect(run).toThrowError(/SUMMARY_KEEP_TOKENS/);
    expect(run).toThrowError(ConfigError);
  });

  it('SUMMARY_TRIM_TOKENS 非正数时报出变量名', () => {
    const run = (): void => {
      loadConfig({ ...BASE, SUMMARY_TRIM_TOKENS: '0' });
    };

    expect(run).toThrowError(/SUMMARY_TRIM_TOKENS/);
    expect(run).toThrowError(ConfigError);
  });

  it('SUMMARY_ENABLED 只接受 true / false', () => {
    const run = (): void => {
      loadConfig({ ...BASE, SUMMARY_ENABLED: 'yes' });
    };

    expect(run).toThrowError(/SUMMARY_ENABLED/);
    expect(run).toThrowError(ConfigError);
  });

  it('SUMMARY_ENABLED=false 时摘要功能被关闭', () => {
    const config = loadConfig({ ...BASE, SUMMARY_ENABLED: 'false' });
    expect(config.summary.enabled).toBe(false);
  });

  it('SUMMARY_ENABLED 不会被字符串 false 误判成开启', () => {
    const config = loadConfig({ ...BASE, SUMMARY_ENABLED: 'false' });
    expect(config.summary.enabled).toBe(false);
    expect(loadConfig({ ...BASE }).summary.enabled).toBe(true);
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
    'SUMMARY_ENABLED',
    'SUMMARY_TRIGGER_TOKENS',
    'SUMMARY_KEEP_TOKENS',
    'SUMMARY_TRIM_TOKENS',
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
    expect(config.summary.enabled).toBe(true);
    expect(config.summary.triggerTokens).toBe(8000);
    expect(config.summary.keepTokens).toBe(2000);
    expect(config.summary.trimTokens).toBe(8000);
  });
});

describe('工具加载与清理配置', () => {
  it('默认值', () => {
    const config = loadConfig({ ...BASE });
    expect(config.toolLoading).toEqual({
      enabled: true,
      eagerMaxTools: 12,
      eagerMaxTokens: 1500,
      catalogMaxTools: 40,
      catalogMaxTokens: 4000,
      searchTopK: 8,
      maxActiveTools: 24,
    });
    expect(config.toolClearing).toEqual({
      enabled: true,
      triggerTokens: 6000,
      keepMessages: 3,
    });
  });

  it('TOOL_LOADING_ENABLED=false 被解析为关闭而非开启', () => {
    expect(loadConfig({ ...BASE, TOOL_LOADING_ENABLED: 'false' }).toolLoading.enabled).toBe(false);
  });

  it('TOOL_CLEARING_ENABLED=false 被解析为关闭而非开启', () => {
    expect(loadConfig({ ...BASE, TOOL_CLEARING_ENABLED: 'false' }).toolClearing.enabled).toBe(false);
  });

  it('数值变量可覆盖', () => {
    const config = loadConfig({
      ...BASE,
      TOOL_LOADING_EAGER_MAX_TOOLS: '3',
      TOOL_LOADING_SEARCH_TOP_K: '2',
      TOOL_CLEARING_KEEP_MESSAGES: '5',
    });
    expect(config.toolLoading.eagerMaxTools).toBe(3);
    expect(config.toolLoading.searchTopK).toBe(2);
    expect(config.toolClearing.keepMessages).toBe(5);
  });

  it('非正数被拒绝并指出变量名', () => {
    for (const key of [
      'TOOL_LOADING_EAGER_MAX_TOOLS',
      'TOOL_LOADING_EAGER_MAX_TOKENS',
      'TOOL_LOADING_CATALOG_MAX_TOOLS',
      'TOOL_LOADING_CATALOG_MAX_TOKENS',
      'TOOL_LOADING_SEARCH_TOP_K',
      'TOOL_LOADING_MAX_ACTIVE',
      'TOOL_CLEARING_TRIGGER_TOKENS',
      'TOOL_CLEARING_KEEP_MESSAGES',
    ]) {
      expect(() => loadConfig({ ...BASE, [key]: '0' })).toThrow(key);
    }
  });

  it('eager 条数上限大于 catalog 条数上限时启动报错', () => {
    expect(() => loadConfig({
      ...BASE,
      TOOL_LOADING_EAGER_MAX_TOOLS: '50',
      TOOL_LOADING_CATALOG_MAX_TOOLS: '40',
    })).toThrow(/TOOL_LOADING_EAGER_MAX_TOOLS/);
  });

  it('eager token 上限大于 catalog token 上限时启动报错', () => {
    expect(() => loadConfig({
      ...BASE,
      TOOL_LOADING_EAGER_MAX_TOKENS: '5000',
      TOOL_LOADING_CATALOG_MAX_TOKENS: '4000',
    })).toThrow(/TOOL_LOADING_EAGER_MAX_TOKENS/);
  });
});
