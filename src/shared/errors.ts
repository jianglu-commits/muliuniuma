export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'PROVIDER_NOT_REGISTERED'
  | 'SANDBOX_ESCAPE'
  | 'SANDBOX_EXEC_FAILED'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_PARSE_FAILED'
  | 'A2A_PEER_UNREACHABLE';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFIG_INVALID', message, options);
  }
}

export class ProviderNotRegisteredError extends AppError {
  constructor(provider: string) {
    super(
      'PROVIDER_NOT_REGISTERED',
      `未注册的 LLM provider: "${provider}"。请先安装对应的 @langchain/* 包，` +
        `然后在 src/llm/factory.ts 调用 registerProvider("${provider}", ...)。`,
    );
  }
}

export class SandboxEscapeError extends AppError {
  constructor(path: string) {
    super('SANDBOX_ESCAPE', `沙箱路径越界: ${path}`);
  }
}

export class SkillNotFoundError extends AppError {
  constructor(name: string) {
    super('SKILL_NOT_FOUND', `未找到 skill: ${name}`);
  }
}

export class SkillParseError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('SKILL_PARSE_FAILED', message, options);
  }
}
