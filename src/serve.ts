import { AgentRuntime } from './agent/index.js';
import { buildAgentCard, createA2AServer } from './a2a/index.js';
import { loadConfig, loadEnvFileIfPresent } from './config/index.js';
import { createLogger } from './shared/index.js';

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'serve');

  const runtime = await AgentRuntime.create(config);

  const app = createA2AServer({
    cardProvider: () =>
      buildAgentCard({
        name: config.a2a.agentName,
        description: config.a2a.description,
        publicUrl: config.a2a.publicUrl,
        skills: runtime.listSkills().map((manifest) => ({
          id: manifest.name,
          name: manifest.name,
          description: manifest.description,
        })),
      }),
    // AgentRuntime 结构上满足 AgentRunner（含 signal），直传才能让取消信号一路传到 agent.invoke。
    runner: runtime,
  });

  const server = app.listen(config.a2a.port, () => {
    logger.info(`A2A server 已启动: ${config.a2a.publicUrl}`);
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = 0;
    try {
      // closeAsync 在 Node v24.19.0 上不存在，用回调包成 promise 以等待连接排空。
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      logger.error('HTTP server 关闭失败', error);
      exitCode = 1;
    }
    try {
      await runtime.dispose();
    } catch (error) {
      logger.error('运行时清理失败', error);
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  console.error(`启动失败: ${error instanceof Error ? error.message : String(error)}`);
  console.error('请复制 .env.example 为 .env 并填入 LLM_API_KEY 等必需变量。');
  process.exit(1);
});
