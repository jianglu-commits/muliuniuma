import express from 'express';
import type { Express } from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { UserBuilder, agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { A2AAgentExecutor } from './executor.js';
import type { AgentRunner } from './executor.js';

export interface A2AServerOptions {
  cardProvider: () => AgentCard;
  runner: AgentRunner;
}

export function createA2AServer(options: A2AServerOptions): Express {
  const app = express();
  const card = options.cardProvider();

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new A2AAgentExecutor(options.runner),
  );

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: { getAgentCard: async () => card } }),
  );

  // body 解析与畸形 JSON 的错误映射都由 jsonRpcHandler 内部完成，应用层不能再挂 express.json()。
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return app;
}