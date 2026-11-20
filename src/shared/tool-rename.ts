import type { StructuredToolInterface } from '@langchain/core/tools';

/**
 * 被代理的原工具是共享单例（MCP 适配器实例 / skill 模块缓存），
 * 写入 name 会让同一工具以两个名字同时暴露给模型。
 */
function renameGuard(name: string): Error {
  return new Error(
    `禁止改写工具的 name（"${name}"）：改名只能通过代理，直接写入会写穿并污染共享的原工具`,
  );
}

/**
 * 用 Proxy 改名而非 invoke 重包装：重包装会把 content_and_artifact 的
 * tuple 拍平成普通内容，工具语义失真。
 *
 * get / set / defineProperty / getOwnPropertyDescriptor 四个陷阱必须同时存在：
 * 只拦 get 时描述符读数会和 .name 打架；只拦 set 时 Object.defineProperty
 * 会按 Proxy 默认行为直接写到 target，set 陷阱形同虚设。
 */
export function renameTool(
  original: StructuredToolInterface,
  name: string,
): StructuredToolInterface {
  return new Proxy(original, {
    get(target, property, receiver) {
      if (property === 'name') return name;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === 'name') throw renameGuard(name);
      return Reflect.set(target, property, value, receiver);
    },
    defineProperty(target, property, attributes) {
      if (property === 'name') throw renameGuard(name);
      return Reflect.defineProperty(target, property, attributes);
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== 'name' || descriptor === undefined) return descriptor;
      // 不可配置且不可写的属性必须原样上报，否则违反 Proxy 不变量。
      if (descriptor.configurable === false && descriptor.writable === false) {
        return descriptor;
      }
      return { ...descriptor, value: name };
    },
  });
}
