import { tool } from 'langchain';
import { z } from 'zod';

export const tools = [
  tool(async ({ value }) => `你好，${value}！`, {
    name: 'echo',
    description: '回显传入的字符串并加前缀问候。',
    schema: z.object({ value: z.string().min(1) }),
  }),
];
