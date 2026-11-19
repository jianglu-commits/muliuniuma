import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { AgentRuntime } from './agent/index.js';
import { loadConfig, loadEnvFileIfPresent } from './config/index.js';
import { createLogger } from './shared/index.js';

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'cli');

  const runtime = await AgentRuntime.create(config);
  const threadId = randomUUID();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    try {
      await runtime.dispose();
    } catch (error) {
      logger.error('运行时清理失败', error);
    }
    process.exit(code);
  };

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  // EOF（Ctrl+D）只 emit close，rl.question 的 promise 永不 settle，必须靠 close 跳出循环。
  let closed = false;
  const closedSignal = new Promise<void>((resolve) => {
    rl.on('close', () => {
      closed = true;
      resolve();
    });
  });
  // closedSignal 整个会话保持 pending，循环内反复 .then 会无界累积反应回调，只挂一次。
  const closedAnswer = closedSignal.then(() => undefined);

  logger.info(`会话已启动（thread=${threadId}），输入 /exit 退出。`);

  try {
    for (;;) {
      const answered = await Promise.race([
        rl.question('> ').catch(() => undefined),
        closedAnswer,
      ]);
      if (closed || answered === undefined) break;
      const line = answered.trim();
      if (line.length === 0) continue;
      if (line === '/exit' || line === '/quit') break;

      try {
        const result = await runtime.run(line, { threadId });
        console.log(result.text);
      } catch (error) {
        logger.error(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await shutdown(0);
  }
}

main().catch((error: unknown) => {
  console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  console.error('请复制 .env.example 为 .env 并填入 LLM_API_KEY 等必需变量。');
  process.exit(1);
});
