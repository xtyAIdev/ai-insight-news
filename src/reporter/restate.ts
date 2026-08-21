/**
 * 英文内容中文重述（报告层前置步骤）
 *
 * 目的：让日报以中文为第一语言 —— 对 TopN 事件做"理解后重述"而非机械翻译：
 *  - 标题：英文/机械标题 → 分析式中文标题（如 "Codex 订阅用量限制..."，不机械保留 "开源项目 X 更新"）
 *  - 正文：英文摘要/描述 → 中文重述（保留事实与数字，不逐字翻译）
 *
 * 降级链：
 *  ① 无 LLM（未配 Key）→ 规则模板兜底（标题仅做模板化改写，正文保留原文并标注）
 *  ② LLM 调用失败 / 输出异常 → 该条单独降级，不阻塞其他条
 * 并发：TopN 事件批量并发调用（默认 4 并发），单条超时 30s。
 */

import type { StandardEvent } from '../types/events.js';
import { getLLM, withLLMFallback } from '../llm/index.js';
import { logger } from '../utils/logger.js';

export interface RestateResult {
  /** 重述后的标题（中文） */
  title: string;
  /** 重述后的正文（中文）；空串表示无正文可重述 */
  body: string;
  /** 是否由 LLM 重述（false = 规则兜底） */
  byLLM: boolean;
}

const CJK_RE = /[\u4e00-\u9fa5]/;
const CONCURRENCY = 4;

/** 判断标题是否已含中文（无需重述） */
function isChineseText(s: string): boolean {
  return CJK_RE.test(s || '');
}

/** 规则兜底：机械标题模板化改写 + 保留英文原文 */
function ruleRestate(evt: StandardEvent): RestateResult {
  let title = evt.title;
  // opensource 的机械标题 "开源项目 X 更新" → "开源项目 X 近期活跃更新（⭐N stars）"
  const m = title.match(/^开源项目\s+(.+?)\s+更新$/);
  if (m) {
    const raw = evt.raw_event;
    const stars = raw && raw.module === 'opensource' && raw.stars > 0 ? `，⭐ ${raw.stars.toLocaleString()}` : '';
    title = `开源项目 ${m[1]} 近期活跃更新${stars}`;
  } else if (isChineseText(title)) {
    // 中文标题保持原样
  } else {
    // 英文标题：保留原文（无法可靠规则翻译），渲染层会标注
  }
  return { title, body: '', byLLM: false };
}

interface LlmRestateItem {
  title: string;
  body: string;
  module: string;
}

/**
 * 对 TopN 事件做中文重述，返回 Map<event_id, RestateResult>。
 * @param events 入选 TopN 的标准化事件
 */
export async function restateEvents(events: StandardEvent[]): Promise<Map<string, RestateResult>> {
  const result = new Map<string, RestateResult>();
  if (events.length === 0) return result;

  const llmAvailable = getLLM().available();

  // 1. 需要重述的条目：标题或正文含英文，且标题非纯中文
  const needRestate = events.filter((e) => !isChineseText(e.title) || !isChineseText(e.description || ''));
  logger.info(`[reporter] 中文重述：${events.length} 条 TopN 中 ${needRestate.length} 条需处理（LLM: ${llmAvailable ? '可用' : '降级'})`);

  if (!llmAvailable) {
    for (const e of events) result.set(e.event_id, ruleRestate(e));
    return result;
  }

  // 2. 并发执行 LLM 重述
  const tasks: Array<{ evt: StandardEvent; item: LlmRestateItem }> = needRestate.map((e) => ({
    evt: e,
    item: { title: e.title, body: (e.description || '').slice(0, 400), module: e.category },
  }));

  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const r = await restateOne(task.item);
      result.set(task.evt.event_id, r ?? ruleRestate(task.evt));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  // 3. 未处理的条目（如纯中文标题）→ 规则兜底
  for (const e of events) {
    if (!result.has(e.event_id)) result.set(e.event_id, ruleRestate(e));
  }
  return result;
}

/** 单条 LLM 重述；失败返回 null（调用方规则兜底） */
async function restateOne(item: LlmRestateItem): Promise<RestateResult | null> {
  const prompt = `你是 AI 行业市场洞察编辑。将以下英文事件改写成中文，要求：
1. 标题：信息密度高的分析式中文标题（10-25 字），保留关键主体与动作，不要机械直译，不要加引号
2. 正文：2-3 句中文重述，保留事实、数字、产品名（产品名可保留英文原名），不要逐字翻译
只输出 JSON：{"title":"中文标题","body":"中文正文"}

模块：${item.module}
原标题：${item.title}
原正文：${item.body || '（无）'}`;

  return withLLMFallback(
    async () => {
      const r = await getLLM().completeJson<{ title?: string; body?: string }>(prompt, 'generate', { maxTokens: 600, retries: 1 });
      if (!r) return null;
      const title = (r.title || '').trim();
      const body = (r.body || '').trim();
      if (!title || !isChineseText(title)) return null; // 标题无中文视为失败
      return { title, body: body || '', byLLM: true };
    },
    async () => null,
    `中文重述(${item.title.slice(0, 30)})`,
  );
}
