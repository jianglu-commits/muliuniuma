import { TaskState } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { buildTextMessage, extractText } from './messages.js';

export interface AgentRunner {
  run(input: string, options: { threadId: string }): Promise<{ text: string }>;
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

    let signalCancel: () => void = () => {};
    const cancelled = new Promise<void>((resolve) => {
      signalCancel = resolve;
    });
    this.activeTasks.set(taskId, { contextId, cancel: signalCancel });

    try {
      const outcome: RunOutcome = await Promise.race([
        this.runner
          .run(extractText(userMessage), { threadId: contextId })
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
