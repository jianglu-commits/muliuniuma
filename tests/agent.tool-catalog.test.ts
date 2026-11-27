import { describe, expect, it } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  briefDescription,
  CATALOG_DESC_LIMIT,
  estimateToolTokens,
  isNamedTool,
  renderCatalog,
  searchCatalog,
  selectTier,
  tokenize,
} from '../src/agent/index.js';
import type { ToolLoadingPolicy } from '../src/agent/index.js';

const POLICY: ToolLoadingPolicy = {
  enabled: true,
  eagerMaxTools: 12,
  eagerMaxTokens: 1500,
  catalogMaxTools: 40,
  catalogMaxTokens: 4000,
  searchTopK: 8,
  maxActiveTools: 24,
};

function makeTool(name: string, description: string, schema = z.object({})): StructuredToolInterface {
  return tool(async () => 'ok', { name, description, schema });
}

describe('estimateToolTokens', () => {
  it('中文描述按一字一 token 计', () => {
    const cjk = makeTool('t', '测'.repeat(40));
    const ascii = makeTool('t', 'a'.repeat(40));
    const cjkTokens = estimateToolTokens(cjk);
    const asciiTokens = estimateToolTokens(ascii);
    expect(cjkTokens - asciiTokens).toBe(30);
  });

  it('schema 也计入：字段更多的工具 token 更高', () => {
    const small = makeTool('t', 'd', z.object({ a: z.string() }));
    const large = makeTool('t', 'd', z.object({
      alpha: z.string().describe('第一个参数'),
      beta: z.number().describe('第二个参数'),
      gamma: z.boolean().describe('第三个参数'),
    }));
    expect(estimateToolTokens(large)).toBeGreaterThan(estimateToolTokens(small));
  });

  it('名字与描述都计入', () => {
    const short = makeTool('a', 'b');
    const long = makeTool('a_very_long_tool_name', 'b_very_long_description_text');
    expect(estimateToolTokens(long)).toBeGreaterThan(estimateToolTokens(short));
  });

  it('仅名字更长（描述与 schema 相同）也计入更多 token', () => {
    const short = makeTool('a', 'same_description');
    const long = makeTool('a_very_long_tool_name', 'same_description');
    expect(estimateToolTokens(long)).toBeGreaterThan(estimateToolTokens(short));
  });
});

describe('selectTier', () => {
  it('条数与 token 都在 eager 预算内走 eager', () => {
    expect(selectTier(12, 1500, POLICY)).toBe('eager');
  });

  it('条数超 eager 上限即升 catalog，即使 token 很小', () => {
    expect(selectTier(13, 10, POLICY)).toBe('catalog');
  });

  it('token 超 eager 上限即升 catalog，即使条数很少', () => {
    expect(selectTier(2, 1501, POLICY)).toBe('catalog');
  });

  it('条数与 token 都在 catalog 预算内走 catalog', () => {
    expect(selectTier(40, 4000, POLICY)).toBe('catalog');
  });

  it('条数超 catalog 上限走 search', () => {
    expect(selectTier(41, 10, POLICY)).toBe('search');
  });

  it('token 超 catalog 上限走 search', () => {
    expect(selectTier(2, 4001, POLICY)).toBe('search');
  });

  it('条数与 token 双超 catalog 上限走 search', () => {
    expect(selectTier(41, 4001, POLICY)).toBe('search');
  });

  it('零工具走 eager', () => {
    expect(selectTier(0, 0, POLICY)).toBe('eager');
  });
});

describe('isNamedTool', () => {
  it('真实工具被判为具名工具', () => {
    expect(isNamedTool(makeTool('t', 'd'))).toBe(true);
  });

  it('provider dict（非 Runnable）不被判为具名工具', () => {
    expect(isNamedTool({ type: 'tool_search' })).toBe(false);
  });

  it('有 name 但非 Runnable 的普通对象不被判为具名工具', () => {
    expect(isNamedTool({ name: 'x', schema: {} })).toBe(false);
  });
});

describe('briefDescription', () => {
  it('只取首行', () => {
    expect(briefDescription('第一行\n第二行')).toBe('第一行');
  });

  it('连续空白折叠成单空格并去掉首尾空白', () => {
    expect(briefDescription('  多个   空格\t和制表  ')).toBe('多个 空格 和制表');
  });

  it('超长截断并补省略号', () => {
    const long = '测'.repeat(200);
    const brief = briefDescription(long);
    expect(brief).toBe(`${'测'.repeat(CATALOG_DESC_LIMIT)}…`);
  });

  it('截断上限就是规格里的 80 个字符', () => {
    // 期望值写死字面量：用 CATALOG_DESC_LIMIT 推导会让常量改了也测不出来。
    expect(briefDescription('测'.repeat(100))).toBe(`${'测'.repeat(80)}…`);
  });

  it('恰好等于上限时不加省略号', () => {
    const exact = '测'.repeat(CATALOG_DESC_LIMIT);
    expect(briefDescription(exact)).toBe(exact);
  });

  it('空描述返回空串', () => {
    expect(briefDescription('')).toBe('');
  });

  it('扩展区汉字按码点截断，保留上限个字符', () => {
    const brief = briefDescription('𠀀'.repeat(100));
    expect(brief).toBe(`${'𠀀'.repeat(CATALOG_DESC_LIMIT)}…`);
    expect([...brief.slice(0, -1)]).toHaveLength(CATALOG_DESC_LIMIT);
    expect(/\p{Surrogate}/u.test(brief)).toBe(false);
  });

  it('截断边界落在代理对中间时不留下孤立代理', () => {
    // 前置一个 ASCII 字符，让第 80 个 UTF-16 码元正好切在代理对中间
    const brief = briefDescription(`a${'𠀀'.repeat(100)}`);
    expect(/\p{Surrogate}/u.test(brief)).toBe(false);
    expect([...brief.slice(0, -1)]).toHaveLength(CATALOG_DESC_LIMIT);
    expect(brief).toBe(`a${'𠀀'.repeat(CATALOG_DESC_LIMIT - 1)}…`);
  });
});

describe('renderCatalog', () => {
  it('空工具集返回空串', () => {
    expect(renderCatalog([])).toBe('');
  });

  it('每个工具一行，含名字与截断后的描述', () => {
    const catalog = renderCatalog([makeTool('fs_read', '读取文件')]);
    expect(catalog).toContain('- fs_read: 读取文件');
  });

  it('长描述被截断，目录体积不随描述线性膨胀', () => {
    const catalog = renderCatalog([makeTool('t', '测'.repeat(500))]);
    expect(catalog).toContain('…');
    expect(catalog.length).toBeLessThan(200);
  });

  it('提示里点名 activate_tools', () => {
    expect(renderCatalog([makeTool('t', 'd')])).toContain('activate_tools');
  });
});

describe('tokenize', () => {
  it('ASCII 按单词切并转小写', () => {
    expect(tokenize('Read_File NOW')).toEqual(['read', 'file', 'now']);
  });

  it('CJK 产出单字与相邻二字', () => {
    expect(tokenize('读文件')).toEqual(['读', '读文', '文', '文件', '件']);
  });

  it('中英混合分别切', () => {
    expect(tokenize('读file')).toEqual(['读', 'file']);
  });

  it('空串返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('searchCatalog', () => {
  const tools = [
    makeTool('fs_read_file', '读取沙箱里的文件内容'),
    makeTool('fs_write_file', '往沙箱写入文本文件'),
    makeTool('ask_remote', '调用远端 agent 协作'),
  ];

  it('中文关键词能召回对应工具', () => {
    const hits = searchCatalog(tools, '写入', 8);
    expect(hits[0]?.name).toBe('fs_write_file');
  });

  it('名字命中权重高于描述命中', () => {
    const hits = searchCatalog(tools, 'read', 8);
    expect(hits[0]?.name).toBe('fs_read_file');
  });

  it('无匹配返回空数组', () => {
    expect(searchCatalog(tools, 'zzzznotfound', 8)).toEqual([]);
  });

  it('空 query 返回空数组', () => {
    expect(searchCatalog(tools, '', 8)).toEqual([]);
  });

  it('topK 截断结果条数', () => {
    expect(searchCatalog(tools, 'file', 1)).toHaveLength(1);
  });

  it('返回完整描述而非截断描述', () => {
    const long = makeTool('t_long', `${'前置说明'.repeat(30)}关键词尾巴`);
    const hits = searchCatalog([long], '关键词尾巴', 8);
    expect(hits[0]?.description).toBe(long.description);
  });

  it('同分时按名字排序，结果稳定', () => {
    const same = [makeTool('b_tool', '共同描述'), makeTool('a_tool', '共同描述')];
    expect(searchCatalog(same, '共同描述', 8).map((m) => m.name)).toEqual(['a_tool', 'b_tool']);
  });

  // 三种命中形态互相竞争，且入参顺序既非分数序也非名字序，排序必须真的干活。
  const competing = [
    makeTool('zzz_other', 'read the thing'),
    makeTool('read_file', '无关说明'),
    makeTool('read_it', 'read again'),
  ];

  it('按分数降序：名字+描述双命中 > 仅名字命中 > 仅描述命中', () => {
    const hits = searchCatalog(competing, 'read', 8);
    expect(hits.map((m) => m.name)).toEqual(['read_it', 'read_file', 'zzz_other']);
  });

  it('名字命中记 2 分、描述命中记 1 分，同一工具两处命中相加', () => {
    const hits = searchCatalog(competing, 'read', 8);
    expect(hits.map((m) => m.score)).toEqual([3, 2, 1]);
  });

  it('topK 留下的是分数最高的前 K 条，不是最差的', () => {
    expect(searchCatalog(competing, 'read', 2).map((m) => m.name)).toEqual(['read_it', 'read_file']);
  });
});
