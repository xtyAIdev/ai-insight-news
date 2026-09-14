/**
 * Source Registry —— 插件式采集源注册表（2026-09-14 架构升级）
 *
 * 设计：pipeline 不再硬编码 switch(module)，而是遍历本注册表。
 * 新增模块/数据源只需：① 实现collector 接口 ② 在 registry 数组登记一条——零 pipeline 改动。
 * 开源后社区可按此接口贡献新源（README 卖点）。
 */

import type { ModuleName, RawEvent, TaskContext } from '../types/events.js';
import { collectOpenSource } from './opensource.js';
import { collectPaper } from './paper.js';
import { collectEnterprise } from './enterprise.js';

/** 采集源插件接口（未来新源只需实现并注册） */
export interface SourcePlugin {
  /** 模块名（= StandardEvent.category） */
  module: ModuleName;
  /** 源描述（诊断日志用） */
  label: string;
  /** 采集入口 */
  collect: (ctx: TaskContext) => Promise<RawEvent[]>;
}

/** 注册表：顺序即 pipeline 执行顺序 */
const REGISTRY: SourcePlugin[] = [
  { module: 'opensource', label: '开源技术（GitHub/ModelScope/HF/Gitee）', collect: (ctx) => collectOpenSource(ctx) as Promise<RawEvent[]> },
  { module: 'paper', label: '学术研究（arXiv/OpenAlex/HF papers）', collect: (ctx) => collectPaper(ctx) as Promise<RawEvent[]> },
  { module: 'enterprise', label: '企业动态（官方 RSS/媒体/投融资）', collect: (ctx) => collectEnterprise(ctx) as Promise<RawEvent[]> },
];

/** 取模块对应的插件；未注册模块返回 undefined（pipeline 记为失败而非崩溃） */
export function getSourcePlugin(module: ModuleName): SourcePlugin | undefined {
  return REGISTRY.find((p) => p.module === module);
}

/** 列出全部已注册插件（CLI list / 诊断用） */
export function listSourcePlugins(): Array<Pick<SourcePlugin, 'module' | 'label'>> {
  return REGISTRY.map(({ module, label }) => ({ module, label }));
}
