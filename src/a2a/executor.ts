import { TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { buildTextMessage, extractText } from './messages.js';

export interface AgentRunner {
  run(
    input: string,
    options: { threadId: string; signal?: AbortSignal },
  ): Promise<{ text: string }>;
}

interface ActiveTask {
  contextId: string;
  cancel: () => void;
}

type RunOutcome = { kind: 'done'; text: string } | { kind: 'cancelled' };

export class A2AAgentExecutor implements AgentExecutor {
  private readonly activeTasks = new Map<string, ActiveTask>();

  constructor(private readonly runner: AgentRunner) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const userMessage = requestContext.userMessage;

    // 先发 task 事件：取消路径要求任务已落库且事件总线仍在，纯 message 流不会持久化任务。
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        metadata: undefined,
      }),
    );

    const controller = new AbortController();
    let signalCancel: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      signalCancel = resolve;
    });
    this.activeTasks.set(taskId, {
      contextId,
      // 必须先 resolve 再 abort：cancelled 要比 runner 的 AbortError 早一个微任务赢下 race，否则 execute 抛出会被 SDK 合成 FAILED。
      cancel: () => {
        signalCancel();
        controller.abort();
      },
    });

    try {
      const outcome: RunOutcome = await Promise.race([
        this.runner
          .run(extractText(userMessage), { threadId: contextId, signal: controller.signal })
          .then((result): RunOutcome => ({ kind: 'done', text: result.text })),
        cancelled.then((): RunOutcome => ({ kind: 'cancelled' })),
      ]);
      if (outcome.kind === 'cancelled') {
        return;
      }
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: buildTextMessage({ text: outcome.text, contextId, taskId }),
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.activeTasks.get(taskId);
    // 空串兜底在正常流不可达：正常取消时 active 必在；二次取消因任务已 CANCELED 被 SDK 幂等返回，不再调 executor。
    const contextId = active?.contextId ?? '';
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: buildTextMessage({ text: `任务 ${taskId} 已取消`, contextId, taskId }),
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    active?.cancel();
  }
}
