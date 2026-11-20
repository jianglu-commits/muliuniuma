import { z } from 'zod';
import { ConfigError } from '../shared/index.js';
import type { LogLevel } from '../shared/index.js';

const EnvSchema = z.object({
  LLM_PROVIDER: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_BASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),

  SANDBOX_ROOT: z.string().min(1).default('.sandbox'),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(262_144),

  CHECKPOINT_DB: z.string().min(1).default('.data/checkpoints.sqlite'),

  SKILLS_DIR: z.string().min(1).default('skills'),
  MCP_CONFIG: z.string().min(1).default('config/mcp.servers.json'),
  A2A_PEERS: z.string().min(1).default('config/a2a.peers.json'),

  A2A_PORT: z.coerce.number().int().min(1).max(65_535).default(4124),
  A2A_PUBLIC_URL: z.url().default('http://localhost:4124'),
  A2A_AGENT_NAME: z.string().min(1).default('muliuniuma'),
  A2A_DESCRIPTION: z.string().min(1).default('可扩展的 TypeScript Agent 运行时'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface AppConfig {
  model: {
    provider: string;
    model: string;
    baseURL: string;
    apiKey: string;
    temperature: number;
  };
  sandbox: {
    root: string;
    timeoutMs: number;
    maxOutputBytes: number;
  };
  checkpointDb: string;
  skillsDir: string;
  mcpConfigPath: string;
  a2aPeersPath: string;
  a2a: {
    port: number;
    publicUrl: string;
    agentName: string;
    description: string;
  };
  logLevel: LogLevel;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`环境变量校验失败 → ${detail}`, { cause: parsed.error });
  }

  const v = parsed.data;

  return {
    model: {
      provider: v.LLM_PROVIDER,
      model: v.LLM_MODEL,
      baseURL: v.LLM_BASE_URL,
      apiKey: v.LLM_API_KEY,
      temperature: v.LLM_TEMPERATURE,
    },
    sandbox: {
      root: v.SANDBOX_ROOT,
      timeoutMs: v.SANDBOX_TIMEOUT_MS,
      maxOutputBytes: v.SANDBOX_MAX_OUTPUT_BYTES,
    },
    checkpointDb: v.CHECKPOINT_DB,
    skillsDir: v.SKILLS_DIR,
    mcpConfigPath: v.MCP_CONFIG,
    a2aPeersPath: v.A2A_PEERS,
    a2a: {
      port: v.A2A_PORT,
      publicUrl: v.A2A_PUBLIC_URL,
      agentName: v.A2A_AGENT_NAME,
      description: v.A2A_DESCRIPTION,
    },
    logLevel: v.LOG_LEVEL,
  };
}

/**
 * 加载 .env 文件（若存在）。已存在的环境变量优先，不会被文件内容覆盖。
 *
 * 实测（macOS + Node v24.19.0）：process.loadEnvFile 对「文件不存在」和
 * 「文件存在但权限不足（chmod 000）」抛的都是 ENOENT，因此权限不足会被当成
 * 文件不存在静默跳过；路径是目录时抛 ERR_INVALID_ARG_TYPE（非 ENOENT），会继续抛出。
 */
export function loadEnvFileIfPresent(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
